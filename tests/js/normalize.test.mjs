import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalize, pyRound2, pyStrip, pyTruthy, truncateSummary, SUMMARY_CHARS } from "../../site/js/normalize.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));
const RAW = fs
  .readdirSync(path.join(ROOT, "tests/fixtures/raw"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ slug: f.slice(0, -5), payload: readJson("tests/fixtures/raw", f) }));

const KEYS = [
  "id", "title", "status", "whyStopped", "type", "phases", "sponsor", "sponsorClass", "enrollment",
  "start", "primaryCompletion", "primaryCompletionType", "completion", "firstPosted", "lastUpdate",
  "verified", "conditions", "interventions", "hasResults", "summary", "sites",
];

const withSummary = (briefSummary) => ({ protocolSection: { descriptionModule: { briefSummary } } });
const withGeo = (...geoPoints) => ({
  protocolSection: {
    contactsLocationsModule: {
      locations: geoPoints.map((geoPoint, i) => ({ city: `C${i}`, country: "X", status: null, geoPoint })),
    },
  },
});

test("raw fixtures exist and are real API pages", () => {
  assert.ok(RAW.length >= 6);
  for (const { payload } of RAW) {
    assert.ok(Array.isArray(payload.studies) && payload.studies.length > 0);
    assert.equal(typeof payload.totalCount, "number");
  }
});

test("every raw fixture study has the Record shape, keys in Python's order", () => {
  for (const { payload } of RAW) {
    for (const study of payload.studies) {
      const r = normalize(study);
      assert.deepEqual(Object.keys(r), KEYS);
      assert.match(r.id, /^NCT\d{8}$/);
      assert.equal(typeof r.title, "string");
      assert.ok(Array.isArray(r.phases) && Array.isArray(r.conditions) && Array.isArray(r.interventions));
      assert.equal(typeof r.hasResults, "boolean");
      assert.ok(Array.from(r.summary).length <= SUMMARY_CHARS + 1);
      for (const i of r.interventions) assert.deepEqual(Object.keys(i), ["type", "name"]);
      for (const s of r.sites) {
        assert.deepEqual(Object.keys(s), ["lat", "lon", "city", "country", "status"]);
        assert.equal(s.lat, Math.round(s.lat * 100) / 100);
      }
    }
  }
});

test("normalize(raw fixture) equals the prebuilt record Python wrote for the same trial", () => {
  let compared = 0;
  for (const { slug, payload } of RAW) {
    const prebuilt = new Map(readJson("site/data", `${slug}.json`).trials.map((t) => [t.id, t]));
    for (const study of payload.studies) {
      const r = normalize(study);
      const p = prebuilt.get(r.id);
      // The fixtures and data are fetched separately; skip a trial updated in between.
      if (!p || p.lastUpdate !== r.lastUpdate) continue;
      assert.deepEqual(r, p, `${slug} ${r.id}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 50, `compared ${compared}`);
});

test("synthetic page: same expectations as tests/test_fetch.py", () => {
  const [a, b] = readJson("tests/fixtures/synthetic_page.json").studies.map(normalize);
  assert.equal(a.id, "NCT07078461");
  assert.equal(a.status, "RECRUITING");
  assert.deepEqual(a.phases, ["NA"]);
  assert.equal(a.sponsorClass, "OTHER");
  assert.equal(a.enrollment, 25);
  assert.equal(a.primaryCompletion, "2026-12");
  assert.equal(a.primaryCompletionType, "ESTIMATED");
  assert.deepEqual(a.interventions, [{ type: "DEVICE", name: "1927-nm Thulium Laser therapy" }]);
  assert.deepEqual(a.sites, [{ lat: 39.29, lon: -76.61, city: "Baltimore", country: "United States", status: "RECRUITING" }]);
  assert.equal(b.whyStopped, "Low enrollment");
  assert.equal(b.completion, null);
  assert.deepEqual(b.sites, []);
  assert.equal(b.hasResults, true);
  assert.equal(b.summary, "");
  assert.equal(b.primaryCompletionType, null);
});

test("missing modules give nulls and empty arrays, never undefined", () => {
  for (const study of [{}, { protocolSection: {} }, { protocolSection: null }, null]) {
    const r = normalize(study);
    assert.deepEqual(Object.keys(r), KEYS);
    for (const k of KEYS) assert.notEqual(r[k], undefined, k);
    assert.deepEqual(r.phases, []);
    assert.deepEqual(r.conditions, []);
    assert.deepEqual(r.interventions, []);
    assert.deepEqual(r.sites, []);
    assert.equal(r.title, "");
    assert.equal(r.summary, "");
    assert.equal(r.hasResults, false);
    assert.equal(r.enrollment, null);
    assert.equal(r.start, null);
  }
});

test("Python truthiness: `or` fallbacks and bool()", () => {
  const title = (ident) => normalize({ protocolSection: { identificationModule: ident } }).title;
  assert.equal(title({ briefTitle: "", officialTitle: "Official" }), "Official");
  assert.equal(title({ briefTitle: "Brief", officialTitle: "Official" }), "Brief");
  assert.equal(title({ briefTitle: null, officialTitle: "" }), "");

  const hr = (v) => normalize({ hasResults: v }).hasResults;
  assert.equal(hr(true), true);
  assert.equal(hr(false), false);
  assert.equal(hr(0), false);
  assert.equal(hr(1), true);
  assert.equal(hr("false"), true); // bool("false") is True in Python
  assert.equal(hr(""), false);
  assert.equal(hr([]), false);
  assert.equal(hr({}), false);
  assert.equal(hr(undefined), false);

  assert.equal(pyTruthy(NaN), true);
  assert.equal(pyTruthy([0]), true);
  assert.equal(pyTruthy({ a: 1 }), true);

  const design = (dm) => normalize({ protocolSection: { designModule: dm } });
  assert.deepEqual(design({ phases: null }).phases, []);
  assert.deepEqual(design({ phases: ["PHASE1", "PHASE2"] }).phases, ["PHASE1", "PHASE2"]);
  assert.equal(design({ enrollmentInfo: { count: 0 } }).enrollment, 0);
  assert.equal(design({ enrollmentInfo: null }).enrollment, null);
  assert.equal(design({ enrollmentInfo: {} }).enrollment, null);
});

test("date structs, verified date and intervention fields", () => {
  const r = normalize({
    protocolSection: {
      statusModule: {
        overallStatus: "TERMINATED",
        startDateStruct: { date: "2009" },
        primaryCompletionDateStruct: {},
        completionDateStruct: null,
        studyFirstPostDateStruct: { date: "2009-01-02", type: "ACTUAL" },
        statusVerifiedDate: "2012-02",
      },
      armsInterventionsModule: { interventions: [{}, { type: "DRUG" }, { name: "Only a name" }] },
      conditionsModule: { conditions: null },
    },
  });
  assert.equal(r.start, "2009");
  assert.equal(r.primaryCompletion, null);
  assert.equal(r.primaryCompletionType, null);
  assert.equal(r.completion, null);
  assert.equal(r.firstPosted, "2009-01-02");
  assert.equal(r.lastUpdate, null);
  assert.equal(r.verified, "2012-02");
  assert.deepEqual(r.conditions, []);
  assert.deepEqual(r.interventions, [
    { type: null, name: null },
    { type: "DRUG", name: null },
    { type: null, name: "Only a name" },
  ]);
});

test("normalize does not mutate or alias its input", () => {
  const study = readJson("tests/fixtures/synthetic_page.json").studies[0];
  const before = JSON.stringify(study);
  const r = normalize(study);
  assert.equal(JSON.stringify(study), before);
  r.phases.push("X");
  r.conditions.push("X");
  assert.equal(JSON.stringify(study), before);
});

test("sites: only locations with both coordinates, rounded to 2 decimals", () => {
  const r = normalize(
    withGeo({ lat: 39.29038, lon: -76.61219 }, null, {}, { lat: 1 }, { lon: 2 }, { lat: null, lon: 3 }, { lat: 0, lon: 0 }),
  );
  assert.deepEqual(
    r.sites.map((s) => [s.lat, s.lon]),
    [
      [39.29, -76.61],
      [0, 0],
    ],
  );
  assert.deepEqual(r.sites[0], { lat: 39.29, lon: -76.61, city: "C0", country: "X", status: null });
  // A location missing city/country/status gives nulls.
  const bare = normalize({ protocolSection: { contactsLocationsModule: { locations: [{ geoPoint: { lat: 1, lon: 2 } }] } } });
  assert.deepEqual(bare.sites, [{ lat: 1, lon: 2, city: null, country: null, status: null }]);
});

test("pyRound2 matches Python round(x, 2), including half-even ties", () => {
  // Expected values printed by CPython 3.13.
  const cases = [
    [0.125, 0.12], [0.375, 0.38], [0.625, 0.62], [0.875, 0.88], [-0.125, -0.12], [-0.375, -0.38],
    [2.675, 2.67], [1.005, 1], [0.005, 0.01], [0.995, 0.99], [1.115, 1.11], [-1.115, -1.11],
    [12.345, 12.35], [0.015, 0.01], [0.025, 0.03], [0.035, 0.04], [0.045, 0.04],
    [39.29038, 39.29], [-76.61219, -76.61], [40, 40], [0, 0], [179.999, 180], [-179.995, -180],
    [10.5, 10.5], [3.14159, 3.14],
  ];
  for (const [x, want] of cases) assert.equal(pyRound2(x), want, `round(${x}, 2)`);
  // Math.round would get these wrong:
  assert.notEqual(Math.round(0.125 * 100) / 100, pyRound2(0.125));
  assert.notEqual(Math.round(2.675 * 100) / 100, pyRound2(2.675));
  // Small negatives round to -0, like Python's -0.0.
  assert.ok(Object.is(pyRound2(-0.001), -0));
  assert.ok(Object.is(pyRound2(-0), -0));
  // Non-finite and non-numbers pass through.
  assert.ok(Number.isNaN(pyRound2(NaN)));
  assert.equal(pyRound2(Infinity), Infinity);
});

test("pyStrip uses Python's whitespace set, not String.prototype.trim", () => {
  assert.equal(pyStrip(" \t\n\r\x0b\x0cabc\x1c\x1d\x1e\x1f\x85\xa0　 "), "abc");
  assert.equal(pyStrip("﻿abc﻿"), "﻿abc﻿"); // Python keeps the BOM
  assert.equal(pyStrip("​abc"), "​abc"); // zero-width space is not whitespace
  assert.equal(pyStrip("a  b"), "a  b");
  assert.equal(normalize(withSummary("\x85 Hello \x1f")).summary, "Hello");
});

test("summary truncation: 600 code points, back to the last space, then …", () => {
  const words = normalize(withSummary("word ".repeat(400))).summary;
  assert.ok(words.length <= SUMMARY_CHARS + 1);
  assert.ok(words.endsWith("word…"));

  // Exactly 600 characters: untouched. 601: truncated.
  const s600 = "a ".repeat(300).slice(0, 599) + "b";
  assert.equal(normalize(withSummary(s600)).summary, s600);
  const s601 = s600 + "c";
  assert.equal(normalize(withSummary(s601)).summary, s600.slice(0, s600.lastIndexOf(" ")) + "…");

  // No space at all: hard cut at 600.
  assert.equal(truncateSummary("x".repeat(700)), "x".repeat(600) + "…");

  // Astral characters count as one, as in Python (JS .length counts 2).
  const emoji = "😀".repeat(700);
  const cut = truncateSummary(emoji);
  assert.equal(Array.from(cut).length, 601);
  assert.equal(cut, "😀".repeat(600) + "…");
  // 300 emoji (600 UTF-16 units) is not over the limit in code points.
  assert.equal(truncateSummary("😀".repeat(300)), "😀".repeat(300));
  // 300 emoji + space + 299 letters is 600 code points (900 UTF-16 units): kept.
  const six = "😀".repeat(300) + " " + "b".repeat(299);
  assert.equal(truncateSummary(six), six);
  // One more letter makes 601: cut back to the space.
  assert.equal(truncateSummary(six + "b"), "😀".repeat(300) + "…");
  // 599 letters then an emoji then more: the emoji is the 600th code point and stays whole.
  const mixed = "a".repeat(599) + "😀" + "zzz";
  assert.equal(truncateSummary(mixed), "a".repeat(599) + "😀…");
  // Space right at the cut.
  assert.equal(truncateSummary("a".repeat(599) + " " + "b".repeat(10)), "a".repeat(599) + "…");
  // Lone surrogates count as one code point each.
  const lone = "\ud800".repeat(601);
  assert.equal(truncateSummary(lone), "\ud800".repeat(600) + "…");
  // Stripping happens before measuring.
  assert.equal(normalize(withSummary("   " + "x".repeat(600) + "   ")).summary, "x".repeat(600));
});
