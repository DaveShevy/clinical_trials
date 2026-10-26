// Loading trial data: prebuilt files from data/ and live searches against the
// ClinicalTrials.gov API v2. Works in browsers and in Node 22 (global fetch).
//
// Live search uses a plain fetch(url) with no custom headers: the API allows
// simple cross-origin GETs but rejects CORS preflights, which any custom
// header would trigger.

import { normalize } from "./normalize.js";

export const MAX_LIVE_PAGES = 5;
export const LIVE_PAGE_SIZE = 1000;
export const API_URL = "https://clinicaltrials.gov/api/v2/studies";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_WHAT = "trials from ClinicalTrials.gov";

function fetchFn() {
  // Looked up on every call so tests (and polyfills) can replace it.
  if (typeof globalThis.fetch !== "function") throw new Error("This browser cannot load data (fetch is missing).");
  return globalThis.fetch;
}

function abortError() {
  const err = new Error("The search was cancelled.");
  err.name = "AbortError";
  return err;
}

async function getJson(url, what, options) {
  let res;
  try {
    res = await fetchFn()(url, options);
  } catch (err) {
    if (err?.name === "AbortError" || options?.signal?.aborted) throw abortError();
    throw new Error(`Could not load ${what}. Check your internet connection and try again.`, { cause: err });
  }
  if (!res.ok) {
    const err = new Error(httpMessage(res.status, what));
    err.status = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError" || options?.signal?.aborted) throw abortError();
    throw new Error(`Could not read ${what}: the response was not valid data.`, { cause: err });
  }
}

function httpMessage(status, what) {
  if (what === LIVE_WHAT) {
    if (status === 400) return "ClinicalTrials.gov could not run that search. Try a simpler condition name, without special characters.";
    if (status === 403) return "ClinicalTrials.gov refused the request from this page (error 403). Try again later.";
    if (status === 429) return "ClinicalTrials.gov is getting too many requests right now. Wait a minute and try again.";
    if (status >= 500) return `ClinicalTrials.gov is having trouble right now (error ${status}). Try again in a few minutes.`;
    return `ClinicalTrials.gov returned an error (HTTP ${status}). Try again later.`;
  }
  if (status === 404) return `Could not find ${what} (error 404).`;
  return `Could not load ${what} (error ${status}). Try reloading the page.`;
}

/** data/index.json: {fetched, conditions: [{slug, label, group, count}]}. */
export async function loadIndex() {
  const index = await getJson("data/index.json", "the list of prebuilt conditions");
  if (!index || !Array.isArray(index.conditions)) throw new Error("The list of prebuilt conditions is damaged.");
  return index;
}

/**
 * data/<slug>.json: {slug, label, query, fetched, count, trials}, plus the
 * same fields searchLive returns so callers can treat both alike:
 * records (=== trials), totalCount (= count), fetchedCount, capped: false,
 * source: "prebuilt".
 */
export async function loadPrebuilt(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new Error("That is not a known condition.");
  const doc = await getJson(`data/${slug}.json`, "the trial data for this condition");
  if (!doc || !Array.isArray(doc.trials)) throw new Error("The trial data for this condition is damaged.");
  return {
    ...doc,
    records: doc.trials,
    totalCount: typeof doc.count === "number" ? doc.count : doc.trials.length,
    fetchedCount: doc.trials.length,
    capped: false,
    source: "prebuilt",
  };
}

function slugify(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function squash(s) {
  return String(s).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The prebuilt condition a query names, or null. Matches the slug or the
 * label, ignoring case, spacing, quotes and punctuation: "Rosacea",
 * "keratosis pilaris", "keratosis-pilaris", "Atopic dermatitis (eczema)" and
 * "atopic dermatitis" all match. Returns the entry from index.conditions.
 */
export function findPrebuilt(index, query) {
  const conditions = index?.conditions;
  if (!Array.isArray(conditions) || typeof query !== "string") return null;
  const q = squash(query);
  const qs = slugify(query);
  if (!q || !qs) return null;
  for (const c of conditions) {
    if (!c) continue;
    if (q === squash(c.slug ?? "") || q === squash(c.label ?? "")) return c;
  }
  for (const c of conditions) {
    if (!c) continue;
    if (qs === c.slug || qs === slugify(c.label ?? "")) return c;
  }
  return null;
}

/** The API URL for one page of a live search. */
export function liveUrl(query, pageToken) {
  let url =
    `${API_URL}?query.cond=${encodeURIComponent(query)}` +
    `&pageSize=${LIVE_PAGE_SIZE}&countTotal=true&fields=protocolSection,hasResults`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  return url;
}

/**
 * Search ClinicalTrials.gov for a condition, following nextPageToken up to
 * maxPages pages of 1,000.
 *
 * onProgress({page, maxPages, fetchedCount, totalCount}) is called once
 * before the first request (page 0, totalCount null) and after every page.
 *
 * Resolves to {label, query, records, totalCount, fetchedCount, capped,
 * fetched, source: "live"}:
 * - records: normalized, without records lacking an id, de-duplicated by id
 *   and sorted by id (as the prebuilt files are).
 * - totalCount: the API's count of matching trials (first page).
 * - fetchedCount: records.length.
 * - capped: true when more pages were left after maxPages.
 * - fetched: ISO time of the search.
 *
 * Rejects with an Error whose message is plain English. If `signal` aborts,
 * the Error has name "AbortError".
 */
export async function searchLive(query, { onProgress, maxPages = MAX_LIVE_PAGES, signal } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw new Error("Type the name of a condition to search for.");
  const pagesAllowed = Math.max(1, Math.floor(Number(maxPages)) || MAX_LIVE_PAGES);
  const options = signal ? { signal } : undefined;
  const byId = new Map();
  let totalCount = null;
  let token = null;
  let page = 0;
  const progress = () => {
    if (typeof onProgress === "function") {
      onProgress({ page, maxPages: pagesAllowed, fetchedCount: byId.size, totalCount });
    }
  };
  progress();
  do {
    if (signal?.aborted) throw abortError();
    const payload = await getJson(liveUrl(q, token), LIVE_WHAT, options);
    if (!payload || typeof payload !== "object" || (payload.studies != null && !Array.isArray(payload.studies))) {
      throw new Error("ClinicalTrials.gov sent a response this site could not read.");
    }
    page += 1;
    if (totalCount === null && typeof payload.totalCount === "number") totalCount = payload.totalCount;
    for (const study of payload.studies ?? []) {
      const record = normalize(study);
      if (record.id && !byId.has(record.id)) byId.set(record.id, record);
    }
    token = payload.nextPageToken || null;
    progress();
  } while (token && page < pagesAllowed);

  const records = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    label: q,
    query: q,
    records,
    totalCount: totalCount ?? records.length,
    fetchedCount: records.length,
    capped: Boolean(token),
    fetched: new Date().toISOString(),
    source: "live",
  };
}
