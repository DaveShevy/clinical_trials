import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadIndex, loadPrebuilt, findPrebuilt, searchLive, liveUrl, MAX_LIVE_PAGES, LIVE_PAGE_SIZE, API_URL,
} from "../../site/js/data.js";
import { normalize } from "../../site/js/normalize.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));
const RAW = (slug) => readJson("tests/fixtures/raw", `${slug}.json`);
const INDEX = readJson("site/data/index.json");

const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Replace fetch with handler(url, options, callIndex); returns the list of calls. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length - 1);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("MAX_LIVE_PAGES is 5 and pages hold 1,000 trials", () => {
  assert.equal(MAX_LIVE_PAGES, 5);
  assert.equal(LIVE_PAGE_SIZE, 1000);
});

// ---------------------------------------------------------------- prebuilt

test("loadIndex fetches the relative data/index.json", async () => {
  const calls = stubFetch(() => jsonResponse(INDEX));
  const index = await loadIndex();
  assert.deepEqual(index, INDEX);
  assert.deepEqual(calls.map((c) => c.url), ["data/index.json"]);
});

test("loadIndex errors are plain English", async () => {
  stubFetch(() => new Response("nope", { status: 404 }));
  await assert.rejects(loadIndex(), { message: /Could not find the list of prebuilt conditions/ });
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(loadIndex(), { message: /Check your internet connection/ });
  stubFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(loadIndex(), { message: /not valid data/ });
  stubFetch(() => jsonResponse({ fetched: "x" }));
  await assert.rejects(loadIndex(), { message: /damaged/ });
});

test("loadPrebuilt fetches data/<slug>.json and adds the live-search fields", async () => {
  const doc = readJson("site/data/keratosis-pilaris.json");
  const calls = stubFetch(() => jsonResponse(doc));
  const out = await loadPrebuilt("keratosis-pilaris");
  assert.deepEqual(calls.map((c) => c.url), ["data/keratosis-pilaris.json"]);
  for (const k of ["slug", "label", "query", "fetched", "count", "trials"]) assert.deepEqual(out[k], doc[k], k);
  assert.equal(out.records, out.trials);
  assert.equal(out.totalCount, doc.count);
  assert.equal(out.fetchedCount, doc.trials.length);
  assert.equal(out.capped, false);
  assert.equal(out.source, "prebuilt");
});

test("loadPrebuilt refuses odd slugs without fetching", async () => {
  const calls = stubFetch(() => jsonResponse({}));
  for (const bad of ["../index", "Rosacea", "a/b", "", "rosacea.json", "-x", null, undefined, 42]) {
    await assert.rejects(loadPrebuilt(bad), { message: "That is not a known condition." }, String(bad));
  }
  assert.equal(calls.length, 0);
});

test("loadPrebuilt HTTP and shape errors", async () => {
  stubFetch(() => new Response("", { status: 404 }));
  await assert.rejects(loadPrebuilt("rosacea"), (err) => err.status === 404 && /Could not find/.test(err.message));
  stubFetch(() => new Response("", { status: 500 }));
  await assert.rejects(loadPrebuilt("rosacea"), { message: /error 500/ });
  stubFetch(() => jsonResponse({ slug: "rosacea" }));
  await assert.rejects(loadPrebuilt("rosacea"), { message: /damaged/ });
});

test("findPrebuilt matches slug or label, ignoring case, spacing and punctuation", () => {
  const slug = (q) => findPrebuilt(INDEX, q)?.slug ?? null;
  assert.equal(slug("rosacea"), "rosacea");
  assert.equal(slug("Rosacea"), "rosacea");
  assert.equal(slug("  ROSACEA "), "rosacea");
  assert.equal(slug("keratosis pilaris"), "keratosis-pilaris");
  assert.equal(slug("Keratosis   Pilaris"), "keratosis-pilaris");
  assert.equal(slug("keratosis-pilaris"), "keratosis-pilaris");
  assert.equal(slug('"keratosis pilaris"'), "keratosis-pilaris");
  assert.equal(slug("Atopic dermatitis (eczema)"), "atopic-dermatitis");
  assert.equal(slug("atopic dermatitis"), "atopic-dermatitis");
  assert.equal(slug("Hidradenitis Suppurativa"), "hidradenitis-suppurativa");
  assert.equal(slug("eczema"), null); // only part of a label: goes live
  assert.equal(slug("rosacea treatment"), null);
  assert.equal(slug("acn"), null);
  assert.equal(slug(""), null);
  assert.equal(slug("   "), null);
  assert.equal(slug("!!!"), null);
  assert.equal(slug(null), null);
  assert.equal(findPrebuilt(null, "rosacea"), null);
  assert.equal(findPrebuilt({}, "rosacea"), null);
  assert.deepEqual(findPrebuilt(INDEX, "acne"), INDEX.conditions.find((c) => c.slug === "acne"));
});

// ---------------------------------------------------------------- live search

test("liveUrl builds the documented API URL", () => {
  assert.equal(
    liveUrl("keratosis pilaris"),
    `${API_URL}?query.cond=keratosis%20pilaris&pageSize=1000&countTotal=true&fields=protocolSection,hasResults`,
  );
  assert.equal(
    liveUrl("a&b=c", "tok/+=="),
    `${API_URL}?query.cond=a%26b%3Dc&pageSize=1000&countTotal=true&fields=protocolSection,hasResults&pageToken=tok%2F%2B%3D%3D`,
  );
  assert.ok(liveUrl("x").startsWith("https://clinicaltrials.gov/api/v2/studies?"));
});

test("searchLive: one page, normalized and sorted, with no custom headers", async () => {
  const page = RAW("keratosis-pilaris");
  const calls = stubFetch(() => jsonResponse(page));
  const progress = [];
  const out = await searchLive("  keratosis pilaris ", { onProgress: (p) => progress.push(p) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, liveUrl("keratosis pilaris"));
  assert.equal(calls[0].options, undefined); // a plain fetch(url): no headers, no preflight
  assert.equal(out.label, "keratosis pilaris");
  assert.equal(out.query, "keratosis pilaris");
  assert.equal(out.totalCount, page.totalCount);
  assert.equal(out.fetchedCount, page.studies.length);
  assert.equal(out.capped, false);
  assert.equal(out.source, "live");
  assert.ok(!Number.isNaN(Date.parse(out.fetched)));
  assert.match(out.fetched, /^\d{4}-\d{2}-\d{2}T/);
  const expected = page.studies.map(normalize).sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(out.records, expected);
  assert.deepEqual(progress, [
    { page: 0, maxPages: 5, fetchedCount: 0, totalCount: null },
    { page: 1, maxPages: 5, fetchedCount: page.studies.length, totalCount: page.totalCount },
  ]);
});

test("searchLive follows nextPageToken and de-duplicates", async () => {
  const p1 = RAW("rosacea");
  const p2 = { studies: [...RAW("acne").studies, p1.studies[0]] }; // later pages omit totalCount
  const calls = stubFetch((url, _o, i) => jsonResponse(i === 0 ? p1 : p2));
  const out = await searchLive("rosacea");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, liveUrl("rosacea", p1.nextPageToken));
  assert.equal(out.totalCount, p1.totalCount);
  const ids = new Set([...p1.studies, ...p2.studies].map((s) => s.protocolSection.identificationModule.nctId));
  assert.equal(out.fetchedCount, ids.size);
  assert.equal(out.records.length, ids.size);
  assert.equal(out.capped, false);
  const sorted = out.records.map((r) => r.id);
  assert.deepEqual(sorted, [...sorted].sort());
});

test("searchLive stops at maxPages and reports capped", async () => {
  const base = RAW("psoriasis");
  let n = 0;
  const calls = stubFetch(() => {
    n += 1;
    const studies = base.studies.map((s) => ({
      ...s,
      protocolSection: {
        ...s.protocolSection,
        identificationModule: { ...s.protocolSection.identificationModule, nctId: `NCT${String(n * 1000 + base.studies.indexOf(s)).padStart(8, "0")}` },
      },
    }));
    return jsonResponse({ totalCount: 12345, studies, nextPageToken: `t${n}` });
  });
  const progress = [];
  const out = await searchLive("psoriasis", { onProgress: (p) => progress.push(p.page) });
  assert.equal(calls.length, MAX_LIVE_PAGES);
  assert.equal(out.capped, true);
  assert.equal(out.totalCount, 12345);
  assert.equal(out.fetchedCount, MAX_LIVE_PAGES * base.studies.length);
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5]);
  assert.equal(calls[4].url, liveUrl("psoriasis", "t4"));

  n = 0;
  const calls2 = stubFetch(() => {
    n += 1;
    return jsonResponse({ totalCount: 5000, studies: [], nextPageToken: "more" });
  });
  const two = await searchLive("psoriasis", { maxPages: 2 });
  assert.equal(calls2.length, 2);
  assert.equal(two.capped, true);
  assert.equal(two.fetchedCount, 0);

  stubFetch(() => jsonResponse({ totalCount: 5, studies: [], nextPageToken: "more" }));
  assert.equal((await searchLive("x", { maxPages: 0 })).capped, true); // at least one page
});

test("searchLive: zero results is not an error", async () => {
  stubFetch(() => jsonResponse({ totalCount: 0, studies: [] }));
  const out = await searchLive("nothing matches this");
  assert.deepEqual(out.records, []);
  assert.equal(out.totalCount, 0);
  assert.equal(out.fetchedCount, 0);
  assert.equal(out.capped, false);
  stubFetch(() => jsonResponse({}));
  const empty = await searchLive("x");
  assert.equal(empty.totalCount, 0);
});

test("searchLive drops studies without an id", async () => {
  const page = RAW("keratosis-pilaris");
  stubFetch(() => jsonResponse({ totalCount: 10, studies: [...page.studies, { protocolSection: {} }] }));
  const out = await searchLive("kp");
  assert.equal(out.fetchedCount, page.studies.length);
  assert.ok(out.records.every((r) => /^NCT\d{8}$/.test(r.id)));
});

test("searchLive errors are plain-English Errors", async () => {
  await assert.rejects(searchLive(""), { message: /Type the name of a condition/ });
  await assert.rejects(searchLive("   "), { message: /Type the name of a condition/ });
  await assert.rejects(searchLive(null), { message: /Type the name of a condition/ });

  const cases = [
    [400, /could not run that search/],
    [403, /refused/],
    [429, /too many requests/],
    [500, /having trouble right now \(error 500\)/],
    [503, /error 503/],
    [418, /HTTP 418/],
  ];
  for (const [status, re] of cases) {
    stubFetch(() => new Response("{}", { status }));
    await assert.rejects(searchLive("rosacea"), (err) => err instanceof Error && re.test(err.message) && err.status === status, String(status));
  }

  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(searchLive("rosacea"), { message: /Could not load trials from ClinicalTrials\.gov\. Check your internet connection/ });

  stubFetch(() => new Response("not json", { status: 200 }));
  await assert.rejects(searchLive("rosacea"), { message: /not valid data/ });

  stubFetch(() => jsonResponse({ studies: "oops" }));
  await assert.rejects(searchLive("rosacea"), { message: /could not read/ });

  // A failure on a later page is reported too.
  stubFetch((url, o, i) => (i === 0 ? jsonResponse({ ...RAW("rosacea") }) : new Response("", { status: 502 })));
  await assert.rejects(searchLive("rosacea"), { message: /error 502/ });
});

test("searchLive passes the abort signal and reports cancellation as AbortError", async () => {
  const controller = new AbortController();
  const calls = stubFetch((url, options) => {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.headers, undefined);
    controller.abort();
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  await assert.rejects(searchLive("rosacea", { signal: controller.signal }), { name: "AbortError", message: "The search was cancelled." });
  assert.equal(calls.length, 1);

  // Already aborted: no request at all.
  const calls2 = stubFetch(() => jsonResponse({}));
  await assert.rejects(searchLive("rosacea", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls2.length, 0);

  // Aborted between pages: stops before the next request.
  const c3 = new AbortController();
  const calls3 = stubFetch(() => jsonResponse(RAW("rosacea")));
  await assert.rejects(
    searchLive("rosacea", { signal: c3.signal, onProgress: (p) => p.page === 1 && c3.abort() }),
    { name: "AbortError" },
  );
  assert.equal(calls3.length, 1);
});

test("data.js and normalize.js import nothing from the DOM", () => {
  for (const f of ["data.js", "normalize.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "site/js", f), "utf8");
    for (const word of ["document.", "window.", "innerHTML", "localStorage"]) assert.ok(!src.includes(word), `${f}: ${word}`);
  }
});
