// Clinical Trials Explorer: page controller.
//
// Reads ?q= from the URL, loads a prebuilt condition or runs a live search,
// computes everything with analyze.js and draws the nine sections.
//
// Safety rules followed throughout:
// - Text from the data or the API only reaches the DOM through textContent,
//   createElement/createTextNode or Plot (which writes SVG text). No innerHTML.
// - Trial links are only built for ids matching /^NCT\d{8}$/.
// - Every number shown is computed here from the records.
// - The analysis date ("today") is the date the data was fetched, so a
//   listing's "months since planned completion" describes the data as fetched.

import { loadIndex, loadPrebuilt, findPrebuilt, searchLive, MAX_LIVE_PAGES, LIVE_PAGE_SIZE } from "./data.js";
import {
  PHASE_ORDER,
  STATUS_ORDER,
  SPONSOR_ORDER,
  parseDate,
  phaseGroup,
  statusGroup,
  summarize,
  startsByYear,
  phaseByStatus,
  topSponsors,
  sponsorMix,
  interventionTypes,
  topInterventions,
  recruitingSites,
  quietListings,
  searchRecords,
  INTERVENTION_LABELS,
  interventionType,
} from "./analyze.js";
import {
  STATUS_COLORS,
  PHASE_BANDS,
  PHASE_BAND_OF,
  FEW_TRIALS,
  AXIS_FROM,
  startsAxisFrom,
  formatCount,
  formatShare,
  legend,
  phaseLegend,
  statusLegend,
  sponsorLegend,
  startsChart,
  phaseStatusChart,
  sponsorsChart,
  sponsorMixChart,
  mapChart,
  interventionTypesChart,
  topInterventionsChart,
  MAP_DOT_COLOR,
} from "./charts.js";

const DEFAULT_QUERY = "rosacea";
const GRACE_MONTHS = 6;
// rows per page in the trials table: fewer on phones, where each row is a card
const tablePage = () => (window.matchMedia?.("(max-width: 719px)").matches ? 20 : 50);
const QUIET_PAGE = 10;
const CHANGES_PAGE = 20;
const COUNTRY_PAGE = 10;
const TOP_SPONSORS = 10;
const TOP_INTERVENTIONS = 15;
const NCT_RE = /^NCT\d{8}$/;

// Own-key lookup in the label tables, so "toString" and friends never match.
const lookup = (table, key) => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);

/** createElement with props; string children become text nodes. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") for (const [p, v] of Object.entries(value)) node.style.setProperty(p, v);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmt = formatCount;
const pct = formatShare;

function plural(n, one, many = `${one}s`) {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}
const isAre = (n) => (n === 1 ? "is" : "are");
const hasHave = (n) => (n === 1 ? "has" : "have");
const verbS = (n, verb) => (n === 1 ? `${verb}s` : verb);

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function listAnd(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-08-10" -> "10 Aug 2025", "2025-08" -> "Aug 2025", "2025" -> "2025". */
function formatDate(s) {
  if (typeof s !== "string") return "Not given";
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s.trim());
  if (!m) return s;
  if (!m[2]) return m[1];
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return s;
  return m[3] ? `${Number(m[3])}\u00a0${mon}\u00a0${m[1]}` : `${mon}\u00a0${m[1]}`;
}

/** A Date -> "25 Oct 2026" (UTC). */
function formatDay(d) {
  return `${d.getUTCDate()}\u00a0${MONTHS[d.getUTCMonth()]}\u00a0${d.getUTCFullYear()}`;
}

/** ISO timestamp -> "14:05 on 25 Oct 2026" in the viewer's time zone. */
function formatMoment(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "just now";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${time} on ${d.getDate()}\u00a0${MONTHS[d.getMonth()]}\u00a0${d.getFullYear()}`;
}

/** The date the data describes, as a UTC midnight Date (falls back to today). */
function dataDate(fetched) {
  let d = new Date(fetched);
  if (Number.isNaN(d.getTime())) d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const STATUS_LABELS = {
  RECRUITING: "Recruiting",
  NOT_YET_RECRUITING: "Not yet recruiting",
  ENROLLING_BY_INVITATION: "Enrolling by invitation",
  ACTIVE_NOT_RECRUITING: "Active, not recruiting",
  COMPLETED: "Completed",
  TERMINATED: "Terminated",
  WITHDRAWN: "Withdrawn",
  SUSPENDED: "Suspended",
  UNKNOWN: "Unknown status",
  AVAILABLE: "Expanded access: available",
  NO_LONGER_AVAILABLE: "Expanded access: no longer available",
  TEMPORARILY_NOT_AVAILABLE: "Expanded access: temporarily unavailable",
  APPROVED_FOR_MARKETING: "Approved for marketing",
  WITHHELD: "Withheld",
};

function statusLabel(s) {
  if (!s) return "Not given";
  return lookup(STATUS_LABELS, s) ?? capitalise(String(s).toLowerCase().replace(/_/g, " "));
}

const TYPE_LABELS = { INTERVENTIONAL: "Interventional", OBSERVATIONAL: "Observational", EXPANDED_ACCESS: "Expanded access" };

// How each intervention type reads in a sentence ("test a drug").
const TYPE_PHRASES = {
  DRUG: "a drug",
  DEVICE: "a device",
  BEHAVIORAL: "a behavioral intervention",
  PROCEDURE: "a procedure or surgery",
  BIOLOGICAL: "a biological product",
  DIETARY_SUPPLEMENT: "a dietary supplement",
  RADIATION: "radiation",
  GENETIC: "a genetic intervention",
  COMBINATION_PRODUCT: "a combination product",
  DIAGNOSTIC_TEST: "a diagnostic test",
  OTHER: "an intervention of the type “other”",
};

const SPONSOR_PHRASES = {
  Industry: "Companies",
  "Government & public bodies": "Government and other public bodies",
  "Universities, hospitals & other": "Universities, hospitals and other organisations",
};

// Country names that take "the" inside a sentence.
const THE_COUNTRIES = new Set([
  "United States", "United Kingdom", "Netherlands", "Philippines", "Czech Republic", "Dominican Republic",
  "Central African Republic", "United Arab Emirates", "Bahamas", "Gambia", "Maldives", "Comoros",
  "Seychelles", "Solomon Islands", "Marshall Islands", "Democratic Republic of the Congo", "Republic of the Congo",
  "Russian Federation", "Holy See (Vatican City State)", "Cayman Islands", "Faroe Islands", "Virgin Islands (U.S.)",
]);

function inSentence(country) {
  return THE_COUNTRIES.has(country) ? `the ${country}` : country;
}

function trialUrl(id) {
  return typeof id === "string" && NCT_RE.test(id) ? `https://clinicaltrials.gov/study/${id}` : null;
}

function trialTitle(record) {
  const url = trialUrl(record.id);
  const text = record.title || record.id || "Untitled trial";
  return url ? el("a", { href: url }, text) : el("span", {}, text);
}

// The pill says the status as listed ("Not yet recruiting", not just
// "Recruiting"), with its group's colour on the dot. For stopped trials the
// group is added underneath, since "Withdrawn" alone does not say it stopped.
function statusPill(status) {
  const group = statusGroup(status);
  const listed = status ? statusLabel(status) : group;
  const pill = el("span", { class: "pill", style: { "--pill-color": STATUS_COLORS[group] } }, listed);
  if (group === "Stopped early" && listed.toLowerCase() !== group.toLowerCase()) {
    return el("span", { class: "status-cell" }, pill, el("span", { class: "status-raw" }, group));
  }
  return pill;
}

function slugify(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "search";
}

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ state and DOM

const dom = {
  form: $("search-form"),
  input: $("q"),
  datalist: $("condition-list"),
  chips: $("chips"),
  status: $("load-status"),
  results: $("results"),
  kicker: $("results-kicker"),
  title: $("results-title"),
  meta: $("results-meta"),
  cap: $("cap-notice"),
  footerFetched: $("footer-fetched"),
  downloadCondition: $("download-condition"),
};

const SECTION_IDS = ["glance", "when", "progress", "sponsors", "where", "tested", "quiet", "trials", "changes"];

const state = {
  indexPromise: null,
  index: null,
  loadId: 0,
  controller: null,
  dataset: null,
  today: null,
  analysis: null,
  progressMode: "share",
  table: { text: "", status: "all", phase: "all", sort: "start-desc", shown: tablePage() },
  quietShown: QUIET_PAGE,
  changesShown: CHANGES_PAGE,
  countriesAll: false,
  changesPromise: null,
  worldPromise: null,
  downloadUrl: null,
};

// ------------------------------------------------------------------ charts and resizing

const charts = new Map(); // container -> {draw, width}
const pending = new Set();
let frame = 0;

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const chart = charts.get(entry.target);
    if (!chart) continue;
    const width = Math.floor(entry.contentRect.width);
    if (width > 0 && width !== chart.width) pending.add(entry.target);
  }
  if (pending.size && !frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const container of pending) drawChart(container);
      pending.clear();
    });
  }
});

function mountChart(container, draw) {
  charts.set(container, { draw, width: 0 });
  resizeObserver.observe(container);
  drawChart(container);
}

function unmountChart(container) {
  charts.delete(container);
  resizeObserver.unobserve(container);
  container.replaceChildren();
}

function drawChart(container) {
  const chart = charts.get(container);
  if (!chart) return;
  const width = Math.floor(container.clientWidth);
  if (width <= 0) return;
  chart.width = width;
  try {
    container.replaceChildren(chart.draw(width));
  } catch (err) {
    console.error(err);
    container.replaceChildren(el("p", { class: "empty" }, "This chart could not be drawn. The numbers are in the table below it."));
  }
}

// ------------------------------------------------------------------ "show the numbers" tables

/** A table in a sideways-scrolling box that keyboard users can focus and scroll. */
function scrollRegion(table, label) {
  return el("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": label }, table);
}

function numbersTable(details, { caption, columns, rows, foot }) {
  const summary = details.querySelector("summary") ?? el("summary", {}, "Show the numbers");
  const thead = el(
    "thead",
    {},
    el("tr", {}, columns.map((c) => el("th", { scope: "col", class: c.num ? "num" : null }, c.label))),
  );
  const tbody = el(
    "tbody",
    {},
    rows.map((row) =>
      el(
        "tr",
        {},
        row.map((cell, i) =>
          i === 0 && !columns[0].num
            ? el("th", { scope: "row" }, cell)
            : el("td", { class: columns[i].num ? "num" : null }, cell),
        ),
      ),
    ),
  );
  const table = el("table", { class: "table table-compact" }, el("caption", { class: "visually-hidden" }, caption), thead, tbody);
  if (foot) table.append(el("tfoot", {}, el("tr", {}, foot.map((cell, i) => el("td", { class: columns[i].num ? "num" : null }, cell)))));
  details.replaceChildren(summary, scrollRegion(table, caption));
  details.hidden = false;
}

// ------------------------------------------------------------------ search, URL state and loading

function currentQuery() {
  return (new URLSearchParams(location.search).get("q") ?? "").trim();
}

function navigate(q, { fromUser = true } = {}) {
  const query = q.trim();
  if (!query) {
    dom.input.focus();
    showStatus([el("p", { class: "notice notice-info" }, "Type the name of a condition to explore, or pick one of the prebuilt conditions.")]);
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set("q", query);
  url.hash = "";
  if (url.href !== location.href) history.pushState(null, "", url);
  run(query, { fromUser });
}

function showStatus(children) {
  dom.status.replaceChildren(...children);
}

function progressBlock(text, fraction, { onCancel } = {}) {
  const bar = el("div", { class: "progress-bar" });
  const track = el("div", { class: fraction == null ? "progress progress-indeterminate" : "progress", "aria-hidden": "true" }, bar);
  if (fraction != null) bar.style.width = `${Math.round(Math.max(0.03, Math.min(1, fraction)) * 100)}%`;
  const line = el("div", { class: "loading-line" }, el("p", { class: "loading-text" }, text));
  if (onCancel) line.append(el("button", { type: "button", class: "btn btn-secondary btn-small", onclick: onCancel }, "Cancel"));
  return el("div", { class: "loading" }, line, track);
}

function showProgress(query, { maxPages, fetchedCount, totalCount }) {
  const cancel = () => state.controller?.abort();
  if (totalCount == null) {
    showStatus([progressBlock(`Searching ClinicalTrials.gov for “${query}”…`, null, { onCancel: cancel })]);
    return;
  }
  const limit = maxPages * LIVE_PAGE_SIZE;
  const target = Math.min(totalCount, limit);
  let text = `Loading ${fmt(Math.min(fetchedCount, target))} of ${fmt(totalCount)} trials…`;
  if (totalCount > limit) text += ` This page reads the first ${fmt(limit)}.`;
  showStatus([progressBlock(text, target ? fetchedCount / target : 1, { onCancel: cancel })]);
}

function showError(message, retry) {
  const box = el(
    "div",
    { class: "notice notice-error", role: "alert" },
    el("p", {}, el("strong", {}, "Something went wrong. "), message),
    el(
      "div",
      { class: "notice-actions" },
      el("button", { type: "button", class: "btn btn-small", onclick: retry }, "Try again"),
      el("a", { class: "btn btn-secondary btn-small", href: "?q=rosacea", onclick: chipClick("rosacea") }, "Show rosacea instead"),
    ),
  );
  showStatus([box]);
  box.querySelector("button")?.focus({ preventScroll: true });
}

function chipClick(query) {
  return (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(query);
  };
}

async function run(rawQuery, { fromUser = false } = {}) {
  const id = ++state.loadId;
  state.controller?.abort();
  state.controller = null;
  const query = rawQuery || DEFAULT_QUERY;
  dom.input.value = rawQuery;
  if (!dom.results.hidden) dom.results.classList.add("is-stale");

  const index = await state.indexPromise;
  if (id !== state.loadId) return;
  const entry = index ? findPrebuilt(index, query) : null;

  try {
    let dataset;
    if (entry) {
      // Most prebuilt files arrive quickly: show the loading line only if this
      // one is slow, so it does not flash in and push the page about.
      const slow = setTimeout(() => {
        if (id === state.loadId) showStatus([progressBlock(`Loading ${entry.label}…`, null)]);
      }, 400);
      const doc = await loadPrebuilt(entry.slug).finally(() => clearTimeout(slow));
      dataset = { ...doc, label: entry.label || doc.label, slug: entry.slug };
    } else {
      const controller = new AbortController();
      state.controller = controller;
      dataset = await searchLive(query, {
        signal: controller.signal,
        onProgress: (p) => {
          if (id === state.loadId) showProgress(query, p);
        },
      });
      if (state.controller === controller) state.controller = null;
    }
    if (id !== state.loadId) return;
    try {
      render(dataset, entry);
    } catch (err) {
      // A bug, not a data problem: keep the details for the console.
      console.error(err);
      throw new Error("This page could not draw the results. Try again, or pick another condition.");
    }
    if (fromUser) revealResults();
  } catch (err) {
    if (id !== state.loadId) return;
    state.controller = null;
    dom.results.classList.remove("is-stale");
    if (err?.name === "AbortError") {
      showStatus([
        el(
          "div",
          { class: "notice" },
          el("p", {}, `The search for “${query}” was cancelled.`),
          el("div", { class: "notice-actions" }, el("button", { type: "button", class: "btn btn-small", onclick: () => run(rawQuery, { fromUser: true }) }, "Search again")),
        ),
      ]);
      return;
    }
    dom.results.hidden = true;
    document.title = "Clinical Trials Explorer";
    updateChips(null);
    showError(err?.message || "The data could not be loaded.", () => run(rawQuery, { fromUser: true }));
  }
}

function revealResults() {
  const top = dom.results.getBoundingClientRect().top;
  if (top > window.innerHeight * 0.6 || top < 0) {
    dom.results.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  }
  dom.results.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ prebuilt list

function renderIndex(index) {
  dom.datalist.replaceChildren(...index.conditions.map((c) => el("option", { value: c.label })));
  dom.chips.replaceChildren(
    ...index.conditions.map((c) =>
      el(
        "li",
        {},
        el(
          "a",
          { class: "chip", href: `?q=${encodeURIComponent(c.label)}`, "data-slug": c.slug, onclick: chipClick(c.label) },
          c.label,
          typeof c.count === "number" ? el("span", { class: "chip-count" }, fmt(c.count)) : null,
        ),
      ),
    ),
  );
  updateChips(state.dataset?.slug ?? null);
}

function updateChips(slug) {
  for (const a of dom.chips.querySelectorAll("a.chip")) {
    if (slug && a.dataset.slug === slug) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}

// ------------------------------------------------------------------ render

function render(ds, entry) {
  const records = Array.isArray(ds.records) ? ds.records : [];
  const today = dataDate(ds.fetched);
  state.dataset = ds;
  state.today = today;
  state.table = { text: "", status: "all", phase: "all", sort: "start-desc", shown: tablePage() };
  state.quietShown = QUIET_PAGE;
  state.changesShown = CHANGES_PAGE;
  state.countriesAll = false;

  showStatus([el("p", { class: "visually-hidden" }, `Showing ${plural(records.length, "trial")} for ${ds.source === "live" ? `“${ds.label}”` : ds.label}.`)]);
  document.title = `${ds.label} · Clinical Trials Explorer`;
  updateChips(entry?.slug ?? null);
  dom.results.hidden = false;
  dom.results.classList.remove("is-stale");

  renderHead(ds, records);
  renderFooter(ds);

  const empty = records.length === 0;
  for (const id of SECTION_IDS) $(id).hidden = empty;
  dom.results.querySelector(".toc").hidden = empty;
  for (const container of [...charts.keys()]) unmountChart(container);
  if (empty) return;

  const analysis = {
    summary: summarize(records, today),
    starts: startsByYear(records),
    phaseStatus: phaseByStatus(records),
    sponsors: topSponsors(records, TOP_SPONSORS),
    mix: sponsorMix(records),
    types: interventionTypes(records),
    named: topInterventions(records, TOP_INTERVENTIONS),
    sites: recruitingSites(records, today),
    quiet: quietListings(records, today, GRACE_MONTHS),
  };
  state.analysis = analysis;

  renderGlance(ds, records, analysis);
  renderWhen(ds, records, analysis);
  renderProgress(analysis);
  renderSponsors(records, analysis);
  renderWhere(analysis);
  renderTested(records, analysis);
  renderQuiet(analysis);
  renderTrials(records, analysis);
  renderChanges(ds, records);
}

function subjectName(ds) {
  return ds.source === "live" ? `“${ds.label}”` : ds.label;
}

function renderHead(ds, records) {
  const live = ds.source === "live";
  dom.kicker.textContent = live ? "Live search of ClinicalTrials.gov" : "Prebuilt condition";
  dom.title.textContent = live ? `“${ds.label}”` : ds.label;
  const parts = [];
  if (live) {
    parts.push(`${plural(ds.totalCount ?? records.length, "trial")} matched on ClinicalTrials.gov`);
    parts.push(`searched at ${formatMoment(ds.fetched)}`);
  } else {
    parts.push(plural(records.length, "trial"));
    parts.push(`data fetched ${formatDay(dataDate(ds.fetched))}`);
    if (ds.query) parts.push(`ClinicalTrials.gov search: ${ds.query}`);
  }
  dom.meta.textContent = parts.join(" · ");

  dom.cap.replaceChildren();
  if (live && records.length === 0) {
    const conditions = state.index?.conditions ?? [];
    dom.cap.append(
      el(
        "div",
        { class: "notice notice-info" },
        el("p", {}, `ClinicalTrials.gov has no trials whose conditions match “${ds.label}”.`),
        el("p", {}, `Check the spelling, or try a broader or more common name (for example “eczema” rather than a subtype)${conditions.length ? ", or open a prebuilt condition:" : "."}`),
        conditions.length
          ? el(
              "ul",
              { class: "chips", "aria-label": "Prebuilt conditions" },
              conditions.map((c) => el("li", {}, el("a", { class: "chip", href: `?q=${encodeURIComponent(c.label)}`, onclick: chipClick(c.label) }, c.label))),
            )
          : null,
        el(
          "div",
          { class: "notice-actions" },
          el(
            "button",
            {
              type: "button",
              class: "btn btn-small",
              onclick: () => {
                dom.input.select();
                dom.input.focus();
                dom.form.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
              },
            },
            "Search again",
          ),
        ),
      ),
    );
  } else if (live && ds.capped) {
    dom.cap.append(
      el(
        "p",
        { class: "notice notice-warn" },
        el("strong", {}, `Showing the first ${fmt(ds.fetchedCount)} of ${fmt(ds.totalCount)} trials ClinicalTrials.gov returned. `),
        `This page reads at most ${fmt(MAX_LIVE_PAGES * LIVE_PAGE_SIZE)} trials per search, so every number below describes those ${fmt(ds.fetchedCount)}. Try a more specific term to see every matching trial.`,
      ),
    );
  } else if (live && ds.totalCount != null && ds.fetchedCount !== ds.totalCount) {
    dom.cap.append(
      el(
        "p",
        { class: "notice notice-warn" },
        `ClinicalTrials.gov reported ${plural(ds.totalCount, "trial")}, and ${fmt(ds.fetchedCount)} could be read. The numbers below describe those ${fmt(ds.fetchedCount)}.`,
      ),
    );
  }
}

function renderFooter(ds) {
  const day = formatDay(dataDate(ds.fetched));
  dom.footerFetched.textContent =
    ds.source === "live"
      ? `This live search ran at ${formatMoment(ds.fetched)}.`
      : `Data for ${ds.label} fetched on ${day}. Prebuilt conditions are refreshed weekly.`;
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
  if (ds.source === "live") {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            query: ds.query,
            fetched: ds.fetched,
            totalCount: ds.totalCount,
            fetchedCount: ds.fetchedCount,
            capped: ds.capped,
            trials: ds.records,
          },
          null,
          1,
        ),
      ],
      { type: "application/json" },
    );
    state.downloadUrl = URL.createObjectURL(blob);
    dom.downloadCondition.replaceChildren(
      el("a", { href: state.downloadUrl, download: `trials-${slugify(ds.label)}.json` }, "These search results (JSON)"),
      `, ${plural(ds.fetchedCount ?? ds.records.length, "trial")}`,
    );
  } else {
    dom.downloadCondition.replaceChildren(
      el("a", { href: `data/${ds.slug}.json`, download: `${ds.slug}.json` }, `${ds.label} trials (JSON)`),
      `, ${plural(ds.records.length, "trial")}`,
    );
  }
}

// ------------------------------------------------------------------ 1. at a glance

/** "The median trial has 74 participants, enrolled or planned (leaving out ...)" */
function medianSentence(s) {
  const left = [];
  if (s.zeroEnrollment) left.push(`${plural(s.zeroEnrollment, "trial")} that list${s.zeroEnrollment === 1 ? "s" : ""} 0, usually because ${s.zeroEnrollment === 1 ? "it was" : "they were"} withdrawn`);
  if (s.missingEnrollment) left.push(`${plural(s.missingEnrollment, "trial")} with no number`);
  const out = left.length ? ` (leaving out ${listAnd(left)})` : "";
  return `The median trial has ${fmt(Math.round(s.medianEnrollment))} participants, enrolled or planned${out}`;
}

function tile({ label, value, detail, color }) {
  const key = el("span", { class: "tile-key", "aria-hidden": "true", style: color ? { "--tile-color": color } : null });
  return el(
    "li",
    { class: "tile" },
    el("span", { class: "tile-label" }, color ? key : null, label),
    el("span", { class: "tile-value" }, value),
    detail ? el("span", { class: "tile-detail" }, detail) : null,
  );
}

function renderGlance(ds, records, { summary: s }) {
  const live = ds.source === "live";
  let years = "";
  if (s.firstYear != null && s.lastYear != null) {
    years = s.firstYear === s.lastYear ? `, all starting in ${s.firstYear}` : `, with start dates from ${s.firstYear} to ${s.lastYear}`;
  }
  // A live search may read fewer trials than ClinicalTrials.gov reports: capped
  // at the page limit, or a page that could not be read.
  const partial = live && typeof ds.totalCount === "number" && ds.totalCount !== s.total;
  let first;
  if (!live) first = `${ds.label} has ${plural(s.total, "trial")} on ClinicalTrials.gov${years}.`;
  else if (partial) first = `ClinicalTrials.gov lists ${plural(ds.totalCount, "trial")} matching “${ds.label}”; this page covers ${ds.capped ? "the first " : ""}${fmt(s.total)} of them${years}.`;
  else first = `ClinicalTrials.gov lists ${plural(s.total, "trial")} matching “${ds.label}”${years}.`;

  let second = s.recruiting === 0 ? "None is recruiting now" : `Of these, ${fmt(s.recruiting)} ${isAre(s.recruiting)} recruiting now`;
  if (s.withResultsOfCompleted != null) {
    second += `, and ${pct(s.withResultsOfCompleted)} of the ${plural(s.completedInterventional, "completed interventional trial")} ${hasHave(s.completedInterventional)} posted results.`;
  } else {
    second += ".";
  }
  $("glance-finding").textContent = `${first} ${second}`;

  const notYet = records.filter((r) => r.status === "NOT_YET_RECRUITING").length;
  const invite = records.filter((r) => r.status === "ENROLLING_BY_INVITATION").length;
  const recruitParts = [];
  if (notYet) recruitParts.push(`${fmt(notYet)} not yet recruiting`);
  if (invite) recruitParts.push(`${fmt(invite)} by invitation`);

  $("glance-tiles").replaceChildren(
    tile({
      // A partial live search shows only some of the registered trials.
      label: partial ? "Trials on this page" : "Trials registered",
      value: fmt(s.total),
      detail: partial ? `${ds.capped ? "The first " : ""}${fmt(s.total)} of the ${fmt(ds.totalCount)} registered` : s.firstYear != null ? (s.firstYear === s.lastYear ? `Starting in ${s.firstYear}` : `Starting ${s.firstYear}–${s.lastYear}`) : "No start dates given",
    }),
    tile({
      label: "Recruiting now",
      value: fmt(s.recruiting),
      color: STATUS_COLORS.Recruiting,
      detail: recruitParts.length ? `Includes ${listAnd(recruitParts)}` : "As listed by the trials",
    }),
    tile({
      label: "Completed",
      value: fmt(s.completed),
      color: STATUS_COLORS.Completed,
      detail: `${pct(s.completed / s.total)} of all trials`,
    }),
    tile({
      label: "Completed trials with posted results",
      value: s.withResultsOfCompleted == null ? "–" : pct(s.withResultsOfCompleted),
      detail:
        s.withResultsOfCompleted == null
          ? "No completed interventional trials"
          : `${fmt(s.completedInterventionalWithResults)} of ${plural(s.completedInterventional, "completed interventional trial")}`,
    }),
    tile({
      label: "Listings not updated",
      value: fmt(s.quiet),
      detail: `Listed as recruiting ${GRACE_MONTHS}+ months after their planned primary completion`,
    }),
  );

  const notes = [
    `Data from ClinicalTrials.gov, ${live ? `searched at ${formatMoment(ds.fetched)}` : `fetched on ${formatDay(dataDate(ds.fetched))}`}.`,
    "“Recruiting” includes listings that say not yet recruiting or enrolling by invitation.",
    "“Posted results” means results posted on ClinicalTrials.gov; many trials also publish in journals, which this does not count.",
  ];
  if (s.medianEnrollment != null) notes.push(`${medianSentence(s)}.`);
  $("glance-notes").replaceChildren(el("p", {}, notes.join(" ")));
}

// ------------------------------------------------------------------ 2. when research happened

function renderWhen(ds, records, { starts }) {
  const { rows, undated } = starts;
  const dated = records.length - undated;
  const chart = $("when-chart");
  const notes = [];
  const today = state.today;
  const thisYear = today.getUTCFullYear();

  if (rows.length === 0) {
    $("when-finding").textContent = `None of the ${plural(records.length, "trial")} lists a start date.`;
    $("when-legend").replaceChildren();
    unmountChart(chart);
    chart.replaceChildren(el("p", { class: "empty" }, "There is nothing to chart: no trial gives a start date."));
    $("when-notes").replaceChildren();
    $("when-table").hidden = true;
    return;
  }

  const totals = new Map();
  for (const r of rows) totals.set(r.year, (totals.get(r.year) ?? 0) + r.count);
  const years = [...totals.keys()].sort((a, b) => a - b);
  // Half of the dated trials started in `halfYear` or later.
  let acc = 0;
  let halfYear = years.at(-1);
  for (let i = years.length - 1; i >= 0; i -= 1) {
    acc += totals.get(years[i]);
    halfYear = years[i];
    if (acc >= dated / 2) break;
  }
  const peak = Math.max(...totals.values());
  const peakYears = years.filter((y) => totals.get(y) === peak);
  let peakText;
  if (peakYears.length === 1) peakText = `the busiest year was ${peakYears[0]}, with ${plural(peak, "new trial")}`;
  else if (peakYears.length <= 3) peakText = `the busiest years were ${listAnd(peakYears.map(String))}, with ${plural(peak, "new trial")} each`;
  else peakText = `no year had more than ${plural(peak, "new trial")}`;
  const scope = undated ? `the ${plural(dated, "trial")} with a start date` : `the ${fmt(dated)} trials`;
  $("when-finding").textContent =
    dated === 1
      ? `The only dated trial started in ${years[0]}.`
      : `Half of ${scope} began in ${halfYear} or later; ${peakText}.`;

  const phasesPresent = PHASE_ORDER.filter((p) => rows.some((r) => r.phase === p));
  const from = startsAxisFrom(rows);
  const bandsPresent = PHASE_BANDS.filter((b) => rows.some((r) => r.year >= from && PHASE_BAND_OF[r.phase] === b));
  $("when-legend").replaceChildren(phaseLegend(bandsPresent));
  mountChart(chart, (width) => startsChart({ rows, today, from }, { width }));

  const early = rows.filter((r) => r.year < from).reduce((sum, r) => sum + r.count, 0);
  if (early) {
    notes.push(
      `Not drawn: ${plural(early, "trial")} that started before ${from} (the earliest in ${years[0]}); ClinicalTrials.gov opened in ${AXIS_FROM}, so older trials were registered later and are few. The table below has every year.`,
    );
  }
  const planned = records.filter((r) => {
    const d = parseDate(r.start);
    return d && d > today;
  }).length;
  if (years.at(-1) >= thisYear) {
    const lighter = years.at(-1) > thisYear ? `Bars from ${thisYear} on are lighter: ${thisYear} is not over yet, and later years show planned starts only.` : `The ${thisYear} bar is lighter because the year is not over yet.`;
    notes.push(planned ? `${plural(planned, "trial")} ${hasHave(planned)} a planned start date after ${formatDay(today)}. ${lighter}` : lighter);
  }
  if (undated) notes.push(`${plural(undated, "trial")} ${hasHave(undated)} no start date and ${isAre(undated)} not shown.`);
  const asOne = phasesPresent.filter((p) => p === "Early phase 1" || p === "Phase 1/2").map((p) => p.toLowerCase());
  const merged = [];
  if (asOne.length) merged.push(`${listAnd(asOne)} ${asOne.length === 1 ? "counts" : "count"} as phase 1`);
  if (phasesPresent.includes("Phase 2/3")) merged.push("phase 2/3 counts as phase 2");
  if (merged.length) notes.push(`To keep the colours distinct, ${listAnd(merged)}; the tooltip and the table show every phase.`);
  if (phasesPresent.includes("Not phased")) notes.push("“Not phased” covers observational studies and trials of devices, procedures or behaviour, which have no drug phase.");
  notes.push("Phases run from early, small studies of safety (phase 1) to large comparisons (phase 3) and studies after approval (phase 4).");
  $("when-notes").replaceChildren(el("p", {}, notes.join(" ")));

  numbersTable($("when-table"), {
    caption: "Trials started per year, by phase",
    columns: [{ label: "Year" }, ...phasesPresent.map((p) => ({ label: p, num: true })), { label: "All", num: true }],
    rows: years.map((y) => [
      String(y),
      ...phasesPresent.map((p) => fmt(rows.find((r) => r.year === y && r.phase === p)?.count ?? 0)),
      fmt(totals.get(y)),
    ]),
    foot: undated ? [`No date`, ...phasesPresent.map(() => ""), fmt(undated)] : null,
  });
}

// ------------------------------------------------------------------ 3. how far trials get

function renderProgress({ phaseStatus }) {
  const rows = phaseStatus;
  const total = rows.reduce((s, r) => s + r.count, 0);
  const chart = $("progress-chart");
  const modeGroup = $("progress-mode");
  if (total === 0) {
    $("progress-finding").textContent = "None of these trials is interventional (testing an intervention), so there are no phases to compare.";
    $("progress-legend").replaceChildren();
    modeGroup.hidden = true;
    unmountChart(chart);
    chart.replaceChildren(el("p", { class: "empty" }, "No interventional trials to chart."));
    $("progress-notes").replaceChildren();
    $("progress-table").hidden = true;
    return;
  }
  modeGroup.hidden = false;
  const by = (status) => rows.filter((r) => r.status === status).reduce((s, r) => s + r.count, 0);
  const completed = by("Completed");
  const stopped = by("Stopped early");
  const unknown = by("Unknown");
  $("progress-finding").textContent =
    `Of the ${plural(total, "interventional trial")}, ${fmt(completed)} (${pct(completed / total)}) ${completed === 1 ? "has" : "have"} completed and ${fmt(stopped)} (${pct(stopped / total)}) stopped early.`;

  const statusesPresent = STATUS_ORDER.filter((s) => rows.some((r) => r.status === s));
  $("progress-legend").replaceChildren(statusLegend(statusesPresent));
  // Shares of a handful of trials say little: when most rows are small, start on numbers.
  const phaseTotals = PHASE_ORDER.map((p) => rows.filter((r) => r.phase === p).reduce((sum, r) => sum + r.count, 0)).filter(Boolean);
  const smallRows = phaseTotals.filter((t) => t < FEW_TRIALS).length;
  setProgressMode(smallRows > phaseTotals.length / 2 ? "count" : "share");
  const draw = (width) => phaseStatusChart(rows, { width, mode: state.progressMode });
  mountChart(chart, draw);

  const notes = [
    "Interventional trials only: observational studies, which watch without assigning a treatment, are left out.",
    "“Stopped early” covers terminated, withdrawn and suspended trials. Trials stop for many reasons, such as slow enrollment, funding or business decisions; the listing usually says why.",
  ];
  if (unknown) notes.push("“Unknown” means the listing’s status has not been confirmed for over two years.");
  if (smallRows) {
    notes.push(
      `${smallRows === phaseTotals.length ? "Every phase has" : `${plural(smallRows, "phase")} ${hasHave(smallRows)}`} fewer than ${FEW_TRIALS} trials; in the Share view ${smallRows === 1 ? "that row is" : "those rows are"} marked “few trials” and labelled with counts, since a share of a handful of trials says little.`,
    );
  }
  $("progress-notes").replaceChildren(el("p", {}, notes.join(" ")));

  const phases = PHASE_ORDER.filter((p) => rows.some((r) => r.phase === p));
  const cell = (p, s) => rows.find((r) => r.phase === p && r.status === s)?.count ?? 0;
  numbersTable($("progress-table"), {
    caption: "Interventional trials by phase and status",
    columns: [{ label: "Phase" }, ...statusesPresent.map((s) => ({ label: s, num: true })), { label: "All", num: true }],
    rows: phases.map((p) => {
      const t = statusesPresent.reduce((sum, s) => sum + cell(p, s), 0);
      return [p, ...statusesPresent.map((s) => `${fmt(cell(p, s))} (${pct(cell(p, s) / t)})`), fmt(t)];
    }),
    foot: ["All phases", ...statusesPresent.map((s) => `${fmt(by(s))} (${pct(by(s) / total)})`), fmt(total)],
  });
}

function setProgressMode(mode) {
  state.progressMode = mode;
  for (const b of $("progress-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
}

function setupProgressToggle() {
  const group = $("progress-mode");
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    setProgressMode(button.dataset.mode);
    drawChart($("progress-chart"));
  });
}

// ------------------------------------------------------------------ 4. who pays

function renderSponsors(records, { sponsors, mix }) {
  const { rows, others, otherSponsors, sponsorCount } = sponsors;
  // Is the first sponsor left out tied with the last one shown?
  const nextOut = otherSponsors > 0 ? topSponsors(records, TOP_SPONSORS + 1).rows[TOP_SPONSORS] : null;
  const tiedAtCut = Boolean(nextOut && rows.length && nextOut.count === rows.at(-1).count);
  const total = records.length;
  const lead = mix.reduce((a, b) => (b.count > a.count ? b : a));
  const noSponsor = records.filter((r) => typeof r.sponsor !== "string" || !r.sponsor.trim()).length;

  let finding = `${SPONSOR_PHRASES[lead.group]} lead ${pct(lead.share)} of the ${plural(total, "trial")}`;
  if (rows.length && rows[0].count > 1) finding += `; the most frequent lead sponsor, ${rows[0].sponsor}, leads ${fmt(rows[0].count)}.`;
  else if (rows.length) finding += "; no single sponsor leads more than one.";
  else finding += ".";
  $("sponsors-finding").textContent = finding;

  const chart = $("sponsors-chart");
  if (rows.length === 0) {
    $("sponsors-top-note").textContent = "No trial names a lead sponsor.";
    $("sponsors-legend").replaceChildren();
    unmountChart(chart);
    $("sponsors-notes").replaceChildren();
    $("sponsors-table").hidden = true;
  } else {
    $("sponsors-top-note").textContent =
      sponsorCount > rows.length
        ? `The ${fmt(rows.length)} of ${plural(sponsorCount, "lead sponsor")} with the most trials.`
        : `All ${plural(sponsorCount, "lead sponsor")}, by number of trials.`;
    const groupsPresent = SPONSOR_ORDER.filter((g) => rows.some((r) => r.group === g));
    $("sponsors-legend").replaceChildren(sponsorLegend(groupsPresent));
    mountChart(chart, (width) => sponsorsChart(rows, { width }));
    const notes = [];
    const otherTrials = others - noSponsor;
    if (otherSponsors > 0) notes.push(`Not shown: ${plural(otherSponsors, "other sponsor")}, leading ${plural(otherTrials, "trial")} between them.`);
    if (noSponsor > 0) notes.push(`${plural(noSponsor, "trial")} name${noSponsor === 1 ? "s" : ""} no lead sponsor.`);
    notes.push("Names are as each listing gives them, so one organisation can appear under more than one name.");
    if (tiedAtCut) notes.push(`Other sponsors also have ${plural(rows.at(-1).count, "trial")}, like the last one shown; ties are ordered by name.`);
    $("sponsors-notes").replaceChildren(el("p", {}, notes.join(" ")));
    numbersTable($("sponsors-table"), {
      caption: "Lead sponsors with the most trials",
      columns: [{ label: "Lead sponsor" }, { label: "Type" }, { label: "Trials", num: true }],
      rows: rows.map((r) => [r.sponsor, r.group, fmt(r.count)]),
      foot: otherSponsors > 0 || noSponsor > 0 ? ["All others", "", fmt(others)] : null,
    });
  }

  $("mix-note").textContent = `Each of the ${plural(total, "trial")} counted once, by the kind of organisation leading it.`;
  mountChart($("mix-chart"), (width) => sponsorMixChart(mix, { width }));
}

// ------------------------------------------------------------------ 5. where you could take part

function loadWorld() {
  if (!state.worldPromise) {
    state.worldPromise = fetch("vendor/countries-110m.json").then((res) => {
      if (!res.ok) throw new Error(`world map (${res.status})`);
      return res.json();
    });
    state.worldPromise.catch(() => {
      state.worldPromise = null;
    });
  }
  return state.worldPromise;
}

function renderWhere({ sites, summary }) {
  const { points, countries, trialCount, siteCount, notYetPoints } = sites;
  const body = $("where-body");
  const chart = $("where-chart");
  const countriesBox = $("where-countries");
  const recruiting = summary.recruiting;
  const excludedQuiet = summary.quiet;

  if (trialCount === 0) {
    $("where-finding").textContent =
      recruiting === 0
        ? "No trial is recruiting right now, so there is nowhere to take part at the moment."
        : `None of the ${plural(recruiting, "listing")} that say${recruiting === 1 ? "s it is" : " they are"} recruiting gives a recruiting site with a map location.`;
    body.className = "";
    $("where-legend").replaceChildren();
    unmountChart(chart);
    chart.replaceChildren(
      el("p", { class: "empty" }, recruiting === 0 ? "No recruiting trials to map." : "No recruiting sites with map locations."),
    );
    $("where-notes").replaceChildren(
      excludedQuiet ? el("p", {}, `${plural(excludedQuiet, "listing")} that ${isAre(excludedQuiet)} not updated ${isAre(excludedQuiet)} left out (see section 7).`) : "",
    );
    countriesBox.replaceChildren();
    return;
  }

  body.className = "split split-wide-left";
  const top = countries[0];
  const countryCount = countries.length;
  let finding = `${plural(trialCount, "trial")} that say${trialCount === 1 ? "s it is" : " they are"} recruiting list${trialCount === 1 ? "s" : ""} sites at ${plural(siteCount, "place")}`;
  if (countryCount === 1) finding += `${siteCount === 1 ? ", in" : ", all in"} ${inSentence(top.country)}.`;
  else if (countryCount > 1) {
    finding += ` in ${plural(countryCount, "country", "countries")}`;
    const tied = countries.filter((c) => c.trials === top.trials);
    finding +=
      tied.length === 1
        ? `; ${inSentence(top.country)} has the most, with ${plural(top.trials, "trial")} at ${plural(top.sites, "place")}.`
        : tied.length <= 3
          ? `; ${listAnd(tied.map((c) => inSentence(c.country)))} have the most, with ${plural(top.trials, "trial")} each.`
          : ".";
  } else finding += ".";
  $("where-finding").textContent = finding;

  const keyItems = [{ label: "At least one trial there is recruiting now", color: MAP_DOT_COLOR, shape: "dot" }];
  if (notYetPoints) keyItems.push({ label: "Not yet recruiting, or by invitation only", color: MAP_DOT_COLOR, shape: "ring" });
  $("where-legend").replaceChildren(legend(keyItems, { label: "Map key; dot area shows the number of trials" }));

  const busiest = points[0];
  const notes = [];
  if (notYetPoints) {
    notes.push(
      `At ${plural(notYetPoints, "place")} of ${fmt(siteCount)} (rings) no site is recruiting yet: the trial or the site says it is not yet recruiting, or the trial enrols by invitation only.`,
    );
  }
  if (busiest && busiest.trials > 1) {
    notes.push(`The biggest dot, labelled on the map, is ${[busiest.city, busiest.country].filter(Boolean).join(", ")}, with ${plural(busiest.trials, "trial")}.`);
  }
  const leftOut = [];
  if (excludedQuiet) leftOut.push(`${plural(excludedQuiet, "listing")} not updated (section 7)`);
  leftOut.push("sites that have closed or have no map location");
  notes.push(`Left out: ${listAnd(leftOut)}.`);
  notes.push("Each trial sets its own rules for who can join; check its listing and talk to a doctor.");
  $("where-notes").replaceChildren(el("p", {}, notes.join(" ")));

  unmountChart(chart);
  chart.replaceChildren(el("p", { class: "chart-loading" }, "Loading the map…"));
  const loadId = state.loadId;
  loadWorld()
    .then((world) => {
      if (loadId !== state.loadId) return;
      mountChart(chart, (width) => mapChart({ points, world }, { width }));
    })
    .catch(() => {
      if (loadId !== state.loadId) return;
      chart.replaceChildren(el("p", { class: "empty" }, "The world map could not be loaded. The places are listed by country."));
    });

  renderCountries(countries);
}

function renderCountries(countries) {
  const box = $("where-countries");
  const shown = state.countriesAll ? countries : countries.slice(0, COUNTRY_PAGE);
  const table = el(
    "table",
    { class: "table table-compact" },
    el("caption", { class: "visually-hidden" }, "Countries with recruiting sites"),
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Country"), el("th", { scope: "col", class: "num" }, "Trials"), el("th", { scope: "col", class: "num" }, "Places"))),
    el(
      "tbody",
      {},
      shown.map((c) => el("tr", {}, el("th", { scope: "row" }, c.country), el("td", { class: "num" }, fmt(c.trials)), el("td", { class: "num" }, fmt(c.sites)))),
    ),
  );
  const parts = [
    el("h3", { class: "subhead" }, "Countries with recruiting sites"),
    el(
      "p",
      { class: "subnote" },
      countries.length > shown.length
        ? `Top ${fmt(shown.length)} of ${plural(countries.length, "country", "countries")}, by number of trials recruiting or about to.`
        : `${plural(countries.length, "country", "countries")}, by number of trials recruiting or about to.`,
    ),
    table,
  ];
  if (countries.length > COUNTRY_PAGE) {
    parts.push(
      el(
        "div",
        { class: "table-more" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-small",
            onclick: () => {
              state.countriesAll = !state.countriesAll;
              renderCountries(countries);
              $("where-countries").querySelector(".table-more button")?.focus();
            },
          },
          state.countriesAll ? `Show the top ${COUNTRY_PAGE}` : `Show all ${fmt(countries.length)} countries`,
        ),
      ),
    );
  }
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ 6. what gets tested

function renderTested(records, { types, named }) {
  const total = records.length;
  const withInterventions = records.filter((r) => Array.isArray(r.interventions) && r.interventions.length > 0).length;
  const none = total - withInterventions;
  const placebo = named.placeboTrials;
  const sham = named.shamTrials;
  const controls = [];
  if (placebo) controls.push(`${plural(placebo, "trial")} ${placebo === 1 ? "includes" : "include"} a placebo or vehicle (an inactive look-alike)`);
  if (sham) controls.push(`${placebo ? fmt(sham) : `${plural(sham, "trial")} ${sham === 1 ? "includes" : "include"}`} a sham (a pretend version of a device or procedure)`);
  const placeboText = controls.length ? `${controls.join(" and ")} for comparison.` : "none lists a placebo, vehicle or sham for comparison.";

  if (types.length === 0) {
    $("tested-finding").textContent = "None of the trials lists an intervention.";
    for (const id of ["types-chart", "named-chart"]) {
      unmountChart($(id));
      $(id).replaceChildren(el("p", { class: "empty" }, "Nothing to chart."));
    }
    $("types-note").textContent = "";
    $("types-notes").replaceChildren();
    $("named-note").textContent = "";
    $("named-notes").replaceChildren();
    $("types-table").hidden = true;
    $("named-table").hidden = true;
    return;
  }
  const first = types[0];
  $("tested-finding").textContent = `${pct(first.count / total)} of the trials (${fmt(first.count)} of ${fmt(total)}) test ${lookup(TYPE_PHRASES, first.type) ?? first.label.toLowerCase()}, the most common type; ${placeboText}`;

  const typeNotes = [];
  const sum = types.reduce((s, t) => s + t.count, 0);
  if (sum > withInterventions) typeNotes.push("A trial can test more than one type, so the bars add up to more than the number of trials.");
  if (none) typeNotes.push(`${plural(none, "trial")} list${none === 1 ? "s" : ""} no intervention, usually because ${none === 1 ? "it is an observational study" : "they are observational studies"}.`);
  $("types-note").textContent = `Trials testing each type, and their share of all ${plural(total, "trial")}.`;
  $("types-notes").replaceChildren(typeNotes.length ? el("p", {}, typeNotes.join(" ")) : "");
  mountChart($("types-chart"), (width) => interventionTypesChart(types, { width, total }));
  numbersTable($("types-table"), {
    caption: "Trials by type of intervention",
    columns: [{ label: "Type" }, { label: "Trials", num: true }, { label: "Share of all trials", num: true }],
    rows: types.map((t) => [t.label, fmt(t.count), pct(t.count / total)]),
  });

  const { rows, distinct, tiedAtCut } = named;
  const namedNotes = [
    "Names are cleaned (doses, forms such as cream or tablet, and trademark signs removed), split where one listing names several interventions together, and merged when a longer name contains a name used on its own elsewhere, so a brand name with the generic name in brackets counts under the generic name. Brand names and drug codes used on their own can still appear as separate rows.",
    "Placebo, vehicle and sham controls are counted separately, above.",
  ];
  if (rows.length === 0) {
    $("named-h").textContent = "Named interventions";
    $("named-note").textContent = "No named interventions to rank.";
    unmountChart($("named-chart"));
    $("named-notes").replaceChildren();
    $("named-table").hidden = true;
    return;
  }
  if (rows[0].count === 1) {
    // Every name appears in one trial: a ranked chart of equal bars says
    // nothing, so list the names instead.
    const LIST_MAX = 30;
    const names = topInterventions(records, LIST_MAX).rows.map((r) => r.name);
    $("named-h").textContent = "Named interventions";
    $("named-note").textContent =
      distinct > names.length
        ? `Each of the ${fmt(distinct)} named interventions appears in only one trial. The first ${fmt(names.length)}, in alphabetical order:`
        : `Each of the ${plural(distinct, "named intervention")} appears in only one trial:`;
    unmountChart($("named-chart"));
    $("named-chart").replaceChildren(el("ul", { class: "name-list" }, names.map((n) => el("li", {}, n))));
    namedNotes.push("Appearing here means something has been or is being studied, nothing more.");
    $("named-notes").replaceChildren(el("p", {}, namedNotes.join(" ")));
    $("named-table").hidden = true;
    return;
  }
  $("named-h").textContent = "Named in the most trials";
  $("named-note").textContent =
    distinct > rows.length
      ? `The ${fmt(rows.length)} interventions named in the most trials, of ${plural(distinct, "distinct name")}.`
      : `All ${plural(distinct, "distinct name")}, by number of trials.`;
  mountChart($("named-chart"), (width) => topInterventionsChart(rows, { width }));
  if (tiedAtCut) {
    const last = rows.at(-1).count;
    namedNotes.push(`${plural(tiedAtCut, "other name")} also ${tiedAtCut === 1 ? "appears" : "appear"} in ${plural(last, "trial")}, like the last one shown; ties are ordered by name.`);
  }
  namedNotes.push("Appearing here means something has been or is being studied, nothing more.");
  $("named-notes").replaceChildren(el("p", {}, namedNotes.join(" ")));
  numbersTable($("named-table"), {
    caption: "Interventions named in the most trials",
    columns: [{ label: "Intervention" }, { label: "Trials", num: true }, { label: "Names merged", num: true }],
    rows: rows.map((r) => [r.name, fmt(r.count), fmt(r.spellings)]),
  });
}

// ------------------------------------------------------------------ 7. listings not updated

function renderQuiet({ quiet, summary }) {
  const recruiting = summary.recruiting;
  const n = quiet.length;
  let finding;
  const past = `more than ${GRACE_MONTHS} months past`;
  if (n > 0 && recruiting === 1) {
    finding = `The only listing that says it is recruiting is ${past} its planned primary completion date.`;
  } else if (n > 0 && n === recruiting) {
    finding = `All ${fmt(n)} listings that say they are recruiting are ${past} their planned primary completion date.`;
  } else if (n > 0) {
    finding = `${fmt(n)} of the ${fmt(recruiting)} listings that say they are recruiting ${n === 1 ? "is" : "are"} ${past} their planned primary completion date.`;
  } else if (recruiting === 0) {
    finding = "No listing says it is recruiting, so none can be out of date in this way.";
  } else if (recruiting === 1) {
    finding = `The only listing that says it is recruiting is not ${past} its planned primary completion date.`;
  } else {
    finding = `None of the ${fmt(recruiting)} listings that say they are recruiting is ${past} its planned primary completion date.`;
  }
  $("quiet-finding").textContent = finding;
  $("quiet-explain").textContent =
    `A listing counts as not updated here when it still says it is recruiting, but the date it planned to finish collecting its main results passed more than ${GRACE_MONTHS} months before ${formatDay(state.today)}, when this data was fetched. Where a listing gives only a month or a year, the end of that month or year is used. Usually this only means nobody has updated the record: the trial may have finished, paused or moved its dates. If one interests you, the study team can say whether it is still open.`;
  renderQuietTable(quiet);
}

function renderQuietTable(quiet) {
  const box = $("quiet-body");
  if (quiet.length === 0) {
    box.replaceChildren();
    return;
  }
  const shown = quiet.slice(0, state.quietShown);
  const table = el(
    "table",
    { class: "table table-cards table-grid-cards quiet-table" },
    el("caption", { class: "visually-hidden" }, "Listings that say they are recruiting, past their planned primary completion date"),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, "Trial"),
        el("th", { scope: "col" }, "Status as listed"),
        el("th", { scope: "col" }, "Planned primary completion"),
        el("th", { scope: "col", class: "num wrap" }, "Whole months past planned date"),
        el("th", { scope: "col" }, "Lead sponsor"),
      ),
    ),
    el(
      "tbody",
      {},
      shown.map(({ record: r, monthsOverdue }) =>
        el(
          "tr",
          {},
          el(
            "td",
            { class: "cell-main" },
            el("span", { class: "trial-title" }, trialTitle(r)),
            el("span", { class: "trial-meta" }, el("span", { class: "trial-id" }, r.id ?? ""), r.lastUpdate ? ` · Listing last updated ${formatDate(r.lastUpdate)}` : ""),
          ),
          el("td", { "data-label": "Status as listed" }, statusLabel(r.status)),
          el("td", { "data-label": "Planned primary completion", class: "nowrap" }, formatDate(r.primaryCompletion)),
          el("td", { "data-label": "Whole months past planned date", class: "num" }, fmt(monthsOverdue)),
          el("td", { "data-label": "Lead sponsor" }, r.sponsor ?? "Not given"),
        ),
      ),
    ),
  );
  const metaText =
    shown.length < quiet.length
      ? `Showing ${fmt(shown.length)} of ${plural(quiet.length, "listing")}, longest past the planned date first`
      : `${plural(quiet.length, "listing")}, longest past the planned date first`;
  const parts = [el("div", { class: "table-meta" }, el("span", {}, metaText)), table];
  if (quiet.length > shown.length) {
    parts.push(
      el(
        "div",
        { class: "table-more" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-small",
            onclick: () => {
              state.quietShown += QUIET_PAGE;
              renderQuietTable(quiet);
              $("quiet-body").querySelector(".table-more button")?.focus();
            },
          },
          `Show ${fmt(Math.min(QUIET_PAGE, quiet.length - shown.length))} more`,
        ),
      ),
    );
  }
  box.replaceChildren(...parts);
}

// ------------------------------------------------------------------ 8. all trials

const SORTS = {
  "start-desc": (a, b) => cmpDate(b.start, a.start) || cmpId(a, b),
  "start-asc": (a, b) => cmpDate(a.start, b.start, true) || cmpId(a, b),
  "enrollment-desc": (a, b) => (b.enrollment ?? -1) - (a.enrollment ?? -1) || cmpId(a, b),
  "updated-desc": (a, b) => cmpDate(b.lastUpdate, a.lastUpdate) || cmpId(a, b),
  id: (a, b) => cmpId(a, b),
};

function cmpId(a, b) {
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

// Undated records always sort last.
function cmpDate(x, y, ascending = false) {
  const dx = parseDate(x);
  const dy = parseDate(y);
  if (!dx && !dy) return 0;
  if (!dx) return ascending ? 1 : -1;
  if (!dy) return ascending ? -1 : 1;
  return dx - dy;
}

function setupTrialFilters() {
  const text = $("f-text");
  let timer = 0;
  text.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.table.text = text.value;
      state.table.shown = tablePage();
      renderTrialRows();
    }, 150);
  });
  for (const [id, key] of [["f-status", "status"], ["f-phase", "phase"], ["f-sort", "sort"]]) {
    $(id).addEventListener("change", (event) => {
      state.table[key] = event.target.value;
      state.table.shown = tablePage();
      renderTrialRows();
    });
  }
  $("trial-filters").addEventListener("submit", (event) => event.preventDefault());
}

function renderTrials(records, { summary }) {
  const total = records.length;
  $("trials-finding").textContent =
    summary.medianEnrollment != null
      ? `All ${plural(total, "trial")} are listed below. ${medianSentence(summary)}, and the largest has ${fmt(Math.max(...records.map((r) => r.enrollment ?? 0)))}.`
      : `All ${plural(total, "trial")} are listed below.`;

  $("f-text").value = "";
  $("f-sort").value = state.table.sort;
  const statusCounts = new Map(STATUS_ORDER.map((s) => [s, 0]));
  const phaseCounts = new Map(PHASE_ORDER.map((p) => [p, 0]));
  for (const r of records) {
    statusCounts.set(statusGroup(r.status), statusCounts.get(statusGroup(r.status)) + 1);
    phaseCounts.set(phaseGroup(r), phaseCounts.get(phaseGroup(r)) + 1);
  }
  $("f-status").replaceChildren(
    el("option", { value: "all" }, `All statuses (${fmt(total)})`),
    ...STATUS_ORDER.filter((s) => statusCounts.get(s) > 0).map((s) => el("option", { value: s }, `${s} (${fmt(statusCounts.get(s))})`)),
  );
  $("f-phase").replaceChildren(
    el("option", { value: "all" }, `All phases (${fmt(total)})`),
    ...PHASE_ORDER.filter((p) => phaseCounts.get(p) > 0).map((p) => el("option", { value: p }, `${p} (${fmt(phaseCounts.get(p))})`)),
  );
  renderTrialRows();
}

function renderTrialRows() {
  const records = state.dataset.records;
  const { text, status, phase, sort, shown } = state.table;
  const matches = searchRecords(records, { text, statusGroup: status, phase });
  const sorted = matches.slice().sort(SORTS[sort] ?? SORTS["start-desc"]);
  const visible = sorted.slice(0, shown);
  const filtered = matches.length !== records.length;

  const box = $("trials-body");
  let countText;
  if (matches.length === 0) countText = `No trials match these filters (${fmt(records.length)} in all)`;
  else if (filtered && visible.length === matches.length) countText = `${plural(matches.length, "matching trial")} (${fmt(records.length)} in all)`;
  else if (filtered) countText = `Showing ${fmt(visible.length)} of ${plural(matches.length, "matching trial")} (${fmt(records.length)} in all)`;
  else if (visible.length === records.length) countText = `All ${plural(records.length, "trial")}`;
  else countText = `Showing ${fmt(visible.length)} of ${plural(records.length, "trial")}`;
  const meta = el("div", { class: "table-meta" }, el("span", {}, countText));
  // One live region that stays in the page, so screen readers announce each new count.
  const live = $("trials-live");
  if (live && live.textContent !== countText) live.textContent = countText;
  if (filtered) {
    meta.append(
      el(
        "button",
        {
          type: "button",
          class: "btn-link",
          onclick: () => {
            state.table = { ...state.table, text: "", status: "all", phase: "all", shown: tablePage() };
            $("f-text").value = "";
            $("f-status").value = "all";
            $("f-phase").value = "all";
            renderTrialRows();
          },
        },
        "Clear filters",
      ),
    );
  }

  if (matches.length === 0) {
    box.replaceChildren(meta, el("p", { class: "empty" }, "Try fewer words, or set status and phase back to “All”."));
    return;
  }

  const tbody = el("tbody", {});
  for (const r of visible) tbody.append(...trialRows(r));
  const table = el(
    "table",
    { class: "table table-cards table-grid-cards trials-table" },
    el("caption", { class: "visually-hidden" }, "All trials. Use the Details button in each row to show the summary."),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col" }, "Trial"),
        el("th", { scope: "col" }, "Status"),
        el("th", { scope: "col" }, "Phase"),
        el("th", { scope: "col" }, "Lead sponsor"),
        el("th", { scope: "col" }, "Start"),
        el("th", { scope: "col", class: "num" }, "Participants"),
      ),
    ),
    tbody,
  );
  const parts = [meta, table];
  if (matches.length > visible.length) {
    parts.push(
      el(
        "div",
        { class: "table-more" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-small",
            onclick: () => {
              state.table.shown += tablePage();
              renderTrialRows();
              $("trials-body").querySelector(".table-more button")?.focus();
            },
          },
          `Show ${fmt(Math.min(tablePage(), matches.length - visible.length))} more`,
        ),
        el("span", {}, `${fmt(matches.length - visible.length)} not shown yet`),
      ),
    );
  }
  box.replaceChildren(...parts);
}

let detailSeq = 0;

function trialRows(r) {
  const detailId = `trial-detail-${++detailSeq}`;
  const toggle = el(
    "button",
    { type: "button", class: "row-toggle", "aria-expanded": "false", "aria-controls": detailId },
    "Details",
    el("span", { class: "visually-hidden" }, ` for ${r.id ?? "this trial"}`),
  );
  const row = el(
    "tr",
    { class: "trial-row" },
    el(
      "td",
      { class: "cell-main" },
      el("span", { class: "trial-title" }, trialTitle(r)),
      el("span", { class: "trial-meta" }, el("span", { class: "trial-id" }, r.id ?? ""), " ", toggle),
    ),
    el("td", { "data-label": "Status" }, statusPill(r.status)),
    el("td", { "data-label": "Phase", class: "nowrap" }, phaseGroup(r)),
    el("td", { "data-label": "Lead sponsor" }, r.sponsor ?? "Not given"),
    el("td", { "data-label": "Start", class: "nowrap" }, r.start ? formatDate(r.start) : "Not given"),
    el("td", { "data-label": "Participants", class: "num" }, r.enrollment != null ? fmt(r.enrollment) : "Not given"),
  );
  const detail = el("tr", { class: "trial-detail", id: detailId, hidden: true });
  let built = false;
  const setOpen = (open) => {
    if (open && !built) {
      detail.append(el("td", { colspan: "6" }, trialDetail(r)));
      built = true;
    }
    detail.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    row.classList.toggle("is-open", open);
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  row.addEventListener("click", (event) => {
    if (event.target.closest("a, button") || window.getSelection()?.toString()) return;
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  return [row, detail];
}

function trialDetail(r) {
  const facts = [];
  const add = (label, value) => {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return;
    facts.push(el("div", { class: "fact" }, el("dt", {}, label), el("dd", {}, value)));
  };
  add("Conditions", (r.conditions ?? []).join("; "));
  add(
    "Interventions",
    (r.interventions ?? [])
      .filter((i) => i && i.name)
      .map((i) => `${i.name}${i.type ? ` (${INTERVENTION_LABELS[interventionType(i.type)].toLowerCase()})` : ""}`)
      .join("; "),
  );
  add("Study type", lookup(TYPE_LABELS, r.type) ?? (typeof r.type === "string" ? capitalise(r.type.toLowerCase().replace(/_/g, " ")) : null));
  add("Status as listed", statusLabel(r.status));
  if (r.whyStopped) add("Why it stopped, as listed", r.whyStopped);
  if (r.primaryCompletion)
    add(
      r.primaryCompletionType === "ACTUAL" ? "Primary completion" : "Planned primary completion",
      formatDate(r.primaryCompletion),
    );
  add("Results on ClinicalTrials.gov", r.hasResults ? "Posted" : "Not posted");
  add("Listing last updated", r.lastUpdate ? formatDate(r.lastUpdate) : null);
  const sites = Array.isArray(r.sites) ? r.sites.length : 0;
  if (sites) add("Sites with a map location", fmt(sites));

  const url = trialUrl(r.id);
  return el(
    "div",
    { class: "detail" },
    el("p", { class: "detail-label" }, "Summary, in the study team’s words"),
    el("p", { class: "detail-summary" }, r.summary || "No summary given."),
    facts.length ? el("dl", { class: "facts" }, facts) : null,
    url ? el("p", { class: "detail-link" }, el("a", { href: url }, "Full listing on ClinicalTrials.gov"), ` (${r.id})`) : null,
  );
}

// ------------------------------------------------------------------ 9. what changed recently

function loadChanges() {
  if (!state.changesPromise) {
    state.changesPromise = fetch("data/changes.json").then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    });
    state.changesPromise.catch(() => {
      state.changesPromise = null;
    });
  }
  return state.changesPromise;
}

function renderChanges(ds, records) {
  const finding = $("changes-finding");
  const body = $("changes-body");
  if (ds.source === "live") {
    finding.textContent = "Status changes are tracked only for the prebuilt conditions.";
    body.replaceChildren(
      el("p", { class: "section-body" }, "Each week the prebuilt conditions are fetched again and any trial whose status changed is logged. Live searches are a single snapshot, so there is no history to show."),
    );
    return;
  }
  finding.textContent = "Loading the change log…";
  body.replaceChildren();
  const loadId = state.loadId;
  loadChanges()
    .then((feed) => {
      if (loadId !== state.loadId) return;
      const updated = feed?.updated ? formatDay(dataDate(feed.updated)) : null;
      const ids = new Set(records.map((r) => r.id));
      const events = (Array.isArray(feed?.events) ? feed.events : [])
        .filter((e) => e && (e.condition === ds.label || ids.has(e.id)))
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
      if (feed?.baseline) {
        finding.textContent = `Change tracking started on ${updated ?? "the first data fetch"}; changes will show here after the next weekly update.`;
        return;
      }
      if (events.length === 0) {
        finding.textContent = `No status changes have been recorded for ${ds.label} in the weekly checks so far${updated ? `; the last check was on ${updated}` : ""}.`;
        return;
      }
      finding.textContent = `${plural(events.length, "status change")} recorded for ${ds.label}, the latest on ${formatDate(events[0].date)}.`;
      state.changesEvents = events;
      renderChangesTable();
    })
    .catch(() => {
      if (loadId !== state.loadId) return;
      finding.textContent = "The change log could not be loaded.";
    });
}

function renderChangesTable() {
  const events = state.changesEvents ?? [];
  const shown = events.slice(0, state.changesShown);
  const table = el(
    "table",
    { class: "table table-cards changes-table" },
    el("caption", { class: "visually-hidden" }, "Recent status changes"),
    el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Date"), el("th", { scope: "col" }, "Trial"), el("th", { scope: "col" }, "Change"))),
    el(
      "tbody",
      {},
      shown.map((e) =>
        el(
          "tr",
          {},
          el("td", { "data-label": "Date", class: "nowrap" }, formatDate(e.date)),
          el("td", { class: "cell-main" }, el("span", { class: "trial-title" }, trialTitle({ id: e.id, title: e.title })), el("span", { class: "trial-meta" }, el("span", { class: "trial-id" }, e.id ?? ""))),
          el("td", { "data-label": "Change" }, `${e.from ? statusLabel(e.from) : "New listing"} → ${statusLabel(e.to)}`),
        ),
      ),
    ),
  );
  const parts = [
    el("div", { class: "table-meta" }, shown.length < events.length ? `Showing ${fmt(shown.length)} of ${plural(events.length, "change")}, newest first` : `${plural(events.length, "change")}, newest first`),
    table,
  ];
  if (events.length > shown.length) {
    parts.push(
      el(
        "div",
        { class: "table-more" },
        el(
          "button",
          {
            type: "button",
            class: "btn btn-secondary btn-small",
            onclick: () => {
              state.changesShown += CHANGES_PAGE;
              renderChangesTable();
            },
          },
          `Show ${fmt(Math.min(CHANGES_PAGE, events.length - shown.length))} more`,
        ),
      ),
    );
  }
  $("changes-body").replaceChildren(...parts);
}

// ------------------------------------------------------------------ boot

function boot() {
  // A shared link (?q=...) opens on its results: a compact header, so the
  // first numbers are near the top of the screen.
  if (currentQuery()) document.documentElement.classList.add("has-query");
  state.indexPromise = loadIndex()
    .then((index) => {
      state.index = index;
      renderIndex(index);
      return index;
    })
    .catch(() => {
      $("chips-label").hidden = true;
      return null;
    });

  dom.form.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(dom.input.value);
  });
  window.addEventListener("popstate", () => run(currentQuery()));
  setupProgressToggle();
  setupTrialFilters();
  run(currentQuery());
}

boot();
