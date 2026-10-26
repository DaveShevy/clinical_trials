import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as A from "../../site/js/analyze.js";
import { normalize } from "../../site/js/normalize.js";

const {
  parseDate, yearOf, phaseGroup, PHASE_ORDER, statusGroup, STATUS_ORDER, sponsorGroup, SPONSOR_ORDER,
  isQuiet, monthsOverdue, quietListings, summarize, startsByYear, phaseByStatus, topSponsors, sponsorMix,
  interventionTypes, INTERVENTION_LABELS, topInterventions, cleanInterventionName, interventionKey,
  isPlaceboName, isShamName, recruitingSites, searchRecords, RECRUITING_STATUSES, interventionType,
} = A;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));
const INDEX = readJson("site/data/index.json");
const DOCS = INDEX.conditions.map((c) => ({ entry: c, doc: readJson("site/data", `${c.slug}.json`) }));
const RAW_RECORDS = fs
  .readdirSync(path.join(ROOT, "tests/fixtures/raw"))
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => readJson("tests/fixtures/raw", f).studies.map(normalize));

const day = (s) => {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};
const TODAY = day("2026-10-25");
const iso = (date) => date.toISOString().slice(0, 10);

let seq = 0;
function rec(over = {}) {
  seq += 1;
  return {
    id: `NCT${String(seq).padStart(8, "0")}`,
    title: `Trial ${seq}`,
    status: "COMPLETED",
    whyStopped: null,
    type: "INTERVENTIONAL",
    phases: ["PHASE2"],
    sponsor: "Some University",
    sponsorClass: "OTHER",
    enrollment: 50,
    start: "2015-03",
    primaryCompletion: "2017-06",
    primaryCompletionType: "ACTUAL",
    completion: "2017-12",
    firstPosted: "2015-01-10",
    lastUpdate: "2018-01-10",
    verified: "2018-01",
    conditions: ["Rosacea"],
    interventions: [{ type: "DRUG", name: "Drug A" }],
    hasResults: false,
    summary: "",
    sites: [],
    ...over,
  };
}
const site = (over = {}) => ({ lat: 10, lon: 20, city: "Town", country: "Country", status: null, ...over });

// ---------------------------------------------------------------- parseDate

test("parseDate: YYYY, YYYY-MM, YYYY-MM-DD as UTC dates", () => {
  assert.equal(iso(parseDate("2024")), "2024-01-01");
  assert.equal(iso(parseDate("2024-02")), "2024-02-01");
  assert.equal(iso(parseDate("2024-02-15")), "2024-02-15");
  assert.equal(parseDate("2024-02-15").getUTCHours(), 0);
  assert.ok(parseDate("2024") instanceof Date);
});

test("parseDate end: last day of the month or year", () => {
  assert.equal(iso(parseDate("2024", { end: true })), "2024-12-31");
  assert.equal(iso(parseDate("2024-02", { end: true })), "2024-02-29"); // leap year
  assert.equal(iso(parseDate("2023-02", { end: true })), "2023-02-28");
  assert.equal(iso(parseDate("2023-04", { end: true })), "2023-04-30");
  assert.equal(iso(parseDate("2023-12", { end: true })), "2023-12-31");
  assert.equal(iso(parseDate("2023-04-10", { end: true })), "2023-04-10");
  assert.equal(iso(parseDate("1900-02", { end: true })), "1900-02-28");
  assert.equal(iso(parseDate("2000-02", { end: true })), "2000-02-29");
});

test("parseDate: bad input is null", () => {
  for (const bad of [null, undefined, "", "   ", "2024-13", "2024-00", "2024-02-30", "2023-02-29", "2024-1",
    "24", "2024/01/02", "2024-01-02T00:00", "abcd", "2024-01-00", 2024, {}, [], "20240102"]) {
    assert.equal(parseDate(bad), null, JSON.stringify(bad));
  }
  assert.equal(iso(parseDate(" 2024-05 ")), "2024-05-01"); // surrounding spaces are tolerated
});

test("parseDate: years before 100 are not shifted into the 1900s", () => {
  assert.equal(parseDate("0050").getUTCFullYear(), 50);
  assert.equal(yearOf("0099-12-31"), 99);
});

test("yearOf", () => {
  assert.equal(yearOf("2019"), 2019);
  assert.equal(yearOf("2019-07"), 2019);
  assert.equal(yearOf("2019-07-31"), 2019);
  assert.equal(yearOf(null), null);
  assert.equal(yearOf("July 2019"), null);
});

// ---------------------------------------------------------------- groups

test("phaseGroup covers every phase combination", () => {
  const g = (phases, type = "INTERVENTIONAL") => phaseGroup({ phases, type });
  assert.equal(g(["EARLY_PHASE1"]), "Early phase 1");
  assert.equal(g(["PHASE1"]), "Phase 1");
  assert.equal(g(["PHASE1", "PHASE2"]), "Phase 1/2");
  assert.equal(g(["PHASE2", "PHASE1"]), "Phase 1/2");
  assert.equal(g(["PHASE2"]), "Phase 2");
  assert.equal(g(["PHASE2", "PHASE3"]), "Phase 2/3");
  assert.equal(g(["PHASE3"]), "Phase 3");
  assert.equal(g(["PHASE4"]), "Phase 4");
  assert.equal(g(["NA"]), "Not phased");
  assert.equal(g([]), "Not phased");
  assert.equal(g(null), "Not phased");
  assert.equal(g(undefined), "Not phased");
  assert.equal(g(["PHASE2"], "OBSERVATIONAL"), "Not phased");
  assert.equal(g([], "EXPANDED_ACCESS"), "Not phased");
  assert.equal(g(["PHASE3"], null), "Phase 3");
  // Unusual combinations fall back to the highest phase.
  assert.equal(g(["PHASE1", "PHASE3"]), "Phase 3");
  assert.equal(g(["EARLY_PHASE1", "PHASE1"]), "Phase 1");
  assert.equal(g(["NA", "PHASE4"]), "Phase 4");
  assert.equal(g(["SOMETHING_NEW"]), "Not phased");
  assert.equal(phaseGroup(null), "Not phased");
});

test("PHASE_ORDER lists every phase group once, in order", () => {
  assert.deepEqual(PHASE_ORDER, [
    "Early phase 1", "Phase 1", "Phase 1/2", "Phase 2", "Phase 2/3", "Phase 3", "Phase 4", "Not phased",
  ]);
  for (const r of RAW_RECORDS) assert.ok(PHASE_ORDER.includes(phaseGroup(r)));
});

test("statusGroup", () => {
  assert.equal(statusGroup("RECRUITING"), "Recruiting");
  assert.equal(statusGroup("NOT_YET_RECRUITING"), "Recruiting");
  assert.equal(statusGroup("ENROLLING_BY_INVITATION"), "Recruiting");
  assert.equal(statusGroup("ACTIVE_NOT_RECRUITING"), "Active, not recruiting");
  assert.equal(statusGroup("COMPLETED"), "Completed");
  assert.equal(statusGroup("TERMINATED"), "Stopped early");
  assert.equal(statusGroup("WITHDRAWN"), "Stopped early");
  assert.equal(statusGroup("SUSPENDED"), "Stopped early");
  for (const other of ["UNKNOWN", null, undefined, "", "AVAILABLE", "NO_LONGER_AVAILABLE",
    "TEMPORARILY_NOT_AVAILABLE", "APPROVED_FOR_MARKETING", "WITHHELD", "recruiting"]) {
    assert.equal(statusGroup(other), "Unknown", String(other));
  }
  assert.deepEqual(STATUS_ORDER, ["Recruiting", "Active, not recruiting", "Completed", "Stopped early", "Unknown"]);
  assert.deepEqual(RECRUITING_STATUSES, ["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]);
});

test("sponsorGroup", () => {
  assert.equal(sponsorGroup("INDUSTRY"), "Industry");
  // OTHER_GOV is any country's government (most are not U.S.), so the label must not say "U.S.".
  for (const c of ["NIH", "FED", "OTHER_GOV"]) assert.equal(sponsorGroup(c), "Government & public bodies");
  for (const c of ["OTHER", "NETWORK", "INDIV", "AMBIG", "UNKNOWN", null, undefined, "industry"]) {
    assert.equal(sponsorGroup(c), "Universities, hospitals & other", String(c));
  }
  assert.deepEqual(SPONSOR_ORDER, ["Industry", "Government & public bodies", "Universities, hospitals & other"]);
  for (const label of SPONSOR_ORDER) assert.ok(!/U\.S\.|NIH/.test(label), label);
});

// ---------------------------------------------------------------- quiet listings

test("monthsOverdue counts whole months from the planned date (end of a month or year given alone)", () => {
  const m = (pc, today = TODAY) => monthsOverdue({ primaryCompletion: pc }, today);
  assert.equal(m("2026-03"), 6); // from Mar 31: Sep 30 is 6 months on, Oct 31 would be 7
  assert.equal(m("2026-03-01"), 7); // a full date counts from that day, as a reader would
  assert.equal(m("2026-04-30"), 5);
  // The reviewers' examples: the number matches the date printed beside it.
  assert.equal(m("2025-08-10"), 14);
  assert.equal(m("2025-09-01"), 13);
  assert.equal(m("2019-09-15"), 85);
  assert.equal(m("2026-10-25"), 0); // the same day
  assert.equal(m("2026-09-25"), 1); // exactly one month
  assert.equal(m("2026-09-26"), 0);
  assert.equal(m("2026-01-31", day("2026-02-28")), 1); // month ends are clamped
  assert.equal(m("2026-11-10"), -1); // still ahead
  assert.equal(m("2026-09"), 0);
  assert.equal(m("2026-10"), -1);
  assert.equal(m("2027-01"), -4);
  assert.equal(m("2025"), 9); // a year means December
  assert.equal(m("2019-06"), 87);
  assert.equal(m(null), null);
  assert.equal(m("soon"), null);
  assert.throws(() => m("2026-03", "not a date"), TypeError);
  assert.throws(() => m("2026-03", new Date(NaN)), TypeError);
});

test("isQuiet: recruiting and more than 6 months past the planned primary completion date", () => {
  const q = (over, today = TODAY, grace) => isQuiet(rec({ status: "RECRUITING", ...over }), today, grace);
  assert.equal(q({ primaryCompletion: "2026-03" }), true); // ended 2026-03-31; +6 months = 2026-09-30
  assert.equal(q({ primaryCompletion: "2026-04" }), false); // ends 2026-04-30; +6 months = 2026-10-30
  assert.equal(q({ primaryCompletion: "2026-04" }, day("2026-10-30")), false); // exactly 6 months is not more
  assert.equal(q({ primaryCompletion: "2026-04" }, day("2026-10-31")), true);
  // A full date counts from that day (psoriasis NCT07430319, planned 16 Apr 2026, is not updated).
  assert.equal(q({ primaryCompletion: "2026-04-16" }), true);
  assert.equal(q({ primaryCompletion: "2026-04-24" }), true);
  assert.equal(q({ primaryCompletion: "2026-04-25" }), false);
  assert.equal(q({ primaryCompletion: "2026-04-01" }, day("2026-10-01")), false);
  assert.equal(q({ primaryCompletion: "2026-04-01" }, day("2026-10-02")), true);
  assert.equal(q({ primaryCompletion: "2025" }), true);
  assert.equal(q({ primaryCompletion: "2026" }), false);
  assert.equal(q({ primaryCompletion: null }), false);
  assert.equal(q({ primaryCompletion: "garbage" }), false);
  assert.equal(q({ primaryCompletion: "2027-01" }), false);
  for (const status of ["NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"]) {
    assert.equal(q({ status, primaryCompletion: "2020-01" }), true, status);
  }
  for (const status of ["COMPLETED", "ACTIVE_NOT_RECRUITING", "TERMINATED", "UNKNOWN", null]) {
    assert.equal(q({ status, primaryCompletion: "2020-01" }), false, String(status));
  }
  // Grace period is adjustable.
  assert.equal(q({ primaryCompletion: "2026-09" }, TODAY, 0), true);
  assert.equal(q({ primaryCompletion: "2026-09" }, TODAY, 1), false);
  assert.equal(q({ primaryCompletion: "2025-09" }, TODAY, 12), true);
  assert.equal(q({ primaryCompletion: "2025-10" }, TODAY, 12), false);
  assert.equal(isQuiet(null, TODAY), false);
});

test("quietListings: most overdue first, with monthsOverdue", () => {
  const records = [
    rec({ id: "NCT00000003", status: "RECRUITING", primaryCompletion: "2025-01-20" }),
    rec({ id: "NCT00000001", status: "RECRUITING", primaryCompletion: "2019-06" }),
    rec({ id: "NCT00000002", status: "RECRUITING", primaryCompletion: "2025-01-05" }),
    rec({ id: "NCT00000004", status: "RECRUITING", primaryCompletion: "2026-08" }),
    rec({ id: "NCT00000005", status: "COMPLETED", primaryCompletion: "2010-01" }),
    rec({ id: "NCT00000006", status: "NOT_YET_RECRUITING", primaryCompletion: "2025-01" }),
  ];
  const q = quietListings(records, TODAY);
  assert.deepEqual(
    q.map((x) => [x.record.id, x.monthsOverdue]),
    [
      ["NCT00000001", 87],
      ["NCT00000002", 21], // 5 Jan 2025 -> 5 Oct 2026 is 21 months
      ["NCT00000003", 21],
      ["NCT00000006", 20], // "2025-01" counts from 31 Jan 2025
    ],
  );
  assert.equal(q[0].record, records[1]); // the record itself, not a copy
  assert.deepEqual(quietListings([], TODAY), []);
  assert.deepEqual(quietListings(records, TODAY, 100), []);
  assert.throws(() => quietListings(records, undefined), TypeError);
  assert.throws(() => isQuiet(records[4], undefined), TypeError);
});

// ---------------------------------------------------------------- summarize

test("summarize: counts, shares, years and median", () => {
  const records = [
    rec({ status: "RECRUITING", primaryCompletion: "2027-01", sponsorClass: "INDUSTRY", start: "2025", enrollment: 10 }),
    rec({ status: "RECRUITING", primaryCompletion: "2020-01", start: "1999-05-01", enrollment: 30 }), // quiet
    rec({ status: "ENROLLING_BY_INVITATION", primaryCompletion: "2019", enrollment: null }), // quiet
    rec({ status: "ACTIVE_NOT_RECRUITING", sponsorClass: "NIH" }),
    rec({ status: "COMPLETED", hasResults: true, sponsorClass: "INDUSTRY", enrollment: 100 }),
    rec({ status: "COMPLETED", hasResults: false, enrollment: 200 }),
    rec({ status: "COMPLETED", hasResults: true, type: "OBSERVATIONAL", start: "2030-01", enrollment: 0 }),
    rec({ status: "TERMINATED", hasResults: true }),
    rec({ status: "WITHDRAWN", enrollment: 0, start: null }),
    rec({ status: "UNKNOWN", sponsorClass: "INDUSTRY", start: "bad" }),
  ];
  const s = summarize(records, TODAY);
  assert.deepEqual(s, {
    total: 10,
    recruiting: 3,
    active: 1,
    completed: 3,
    stopped: 2,
    unknown: 1,
    withResults: 3,
    withResultsOfCompleted: 0.5, // 2 completed interventional, 1 with results
    completedInterventional: 2,
    completedInterventionalWithResults: 1,
    industryShare: 0.3,
    quiet: 2,
    firstYear: 1999,
    lastYear: 2030,
    // enrollments > 0: 10, 30, 50 (x3 defaults), 100, 200 -> sorted 10 30 50 50 50 100 200
    medianEnrollment: 50,
    enrollmentCounted: 7,
    zeroEnrollment: 2, // the two trials listing 0 (an observational one and a withdrawn one)
    missingEnrollment: 1,
  });
  assert.equal(s.recruiting + s.active + s.completed + s.stopped + s.unknown, s.total);
});

test("summarize: empty input and missing values give nulls, not NaN", () => {
  assert.deepEqual(summarize([], TODAY), {
    total: 0, recruiting: 0, active: 0, completed: 0, stopped: 0, unknown: 0, withResults: 0,
    withResultsOfCompleted: null, completedInterventional: 0, completedInterventionalWithResults: 0,
    industryShare: null, quiet: 0, firstYear: null, lastYear: null, medianEnrollment: null,
    enrollmentCounted: 0, zeroEnrollment: 0, missingEnrollment: 0,
  });
  const s = summarize([rec({ start: null, enrollment: null, status: "RECRUITING", primaryCompletion: null })], TODAY);
  assert.equal(s.firstYear, null);
  assert.equal(s.medianEnrollment, null);
  assert.equal(s.withResultsOfCompleted, null);
  assert.equal(s.quiet, 0);
});

test("summarize: even-sized median averages the middle two", () => {
  const s = summarize([rec({ enrollment: 10 }), rec({ enrollment: 25 }), rec({ enrollment: 40 }), rec({ enrollment: 1000 })], TODAY);
  assert.equal(s.medianEnrollment, 32.5);
  assert.equal(summarize([rec({ enrollment: 7 })], TODAY).medianEnrollment, 7);
});

// ---------------------------------------------------------------- startsByYear / phaseByStatus

test("startsByYear: rows by year and phase, undated counted separately", () => {
  const records = [
    rec({ start: "2010", phases: ["PHASE3"] }),
    rec({ start: "2010-05-02", phases: ["PHASE1", "PHASE2"] }),
    rec({ start: "2010-11", phases: ["PHASE3"] }),
    rec({ start: "2008-01", type: "OBSERVATIONAL", phases: [] }),
    rec({ start: "2012-01", phases: ["NA"] }),
    rec({ start: null }),
    rec({ start: "unknown" }),
  ];
  const { rows, undated } = startsByYear(records);
  assert.deepEqual(rows, [
    { year: 2008, phase: "Not phased", count: 1 },
    { year: 2010, phase: "Phase 1/2", count: 1 },
    { year: 2010, phase: "Phase 3", count: 2 },
    { year: 2012, phase: "Not phased", count: 1 },
  ]);
  assert.equal(undated, 2);
  assert.deepEqual(startsByYear([]), { rows: [], undated: 0 });
});

test("phaseByStatus: interventional trials only, in PHASE_ORDER then STATUS_ORDER", () => {
  const records = [
    rec({ phases: ["PHASE3"], status: "COMPLETED" }),
    rec({ phases: ["PHASE3"], status: "TERMINATED" }),
    rec({ phases: ["PHASE3"], status: "WITHDRAWN" }),
    rec({ phases: ["PHASE1"], status: "RECRUITING" }),
    rec({ phases: ["NA"], status: null }),
    rec({ phases: [], type: "OBSERVATIONAL", status: "COMPLETED" }),
    rec({ phases: ["PHASE2"], type: "EXPANDED_ACCESS", status: "AVAILABLE" }),
  ];
  assert.deepEqual(phaseByStatus(records), [
    { phase: "Phase 1", status: "Recruiting", count: 1 },
    { phase: "Phase 3", status: "Completed", count: 1 },
    { phase: "Phase 3", status: "Stopped early", count: 2 },
    { phase: "Not phased", status: "Unknown", count: 1 },
  ]);
  assert.deepEqual(phaseByStatus([]), []);
});

// ---------------------------------------------------------------- sponsors

test("topSponsors: ranks lead sponsors, merges spelling variants, reports the rest", () => {
  const records = [
    ...Array.from({ length: 4 }, () => rec({ sponsor: "Galderma R&D", sponsorClass: "INDUSTRY" })),
    rec({ sponsor: "galderma  r&d ", sponsorClass: "INDUSTRY" }),
    ...Array.from({ length: 3 }, () => rec({ sponsor: "NIAID", sponsorClass: "NIH" })),
    rec({ sponsor: "NIAID", sponsorClass: "OTHER" }), // the most common class wins
    rec({ sponsor: "Beta Uni", sponsorClass: "OTHER" }),
    rec({ sponsor: "Alpha Uni", sponsorClass: "OTHER" }),
    rec({ sponsor: null, sponsorClass: null }),
    rec({ sponsor: "   ", sponsorClass: "OTHER" }),
  ];
  const t = topSponsors(records, 3);
  assert.deepEqual(t.rows, [
    { sponsor: "Galderma R&D", group: "Industry", count: 5 },
    { sponsor: "NIAID", group: "Government & public bodies", count: 4 },
    { sponsor: "Alpha Uni", group: "Universities, hospitals & other", count: 1 }, // tie broken by name
  ]);
  assert.equal(t.others, 3); // Beta Uni + no sponsor + blank sponsor
  assert.equal(t.otherSponsors, 1);
  assert.equal(t.sponsorCount, 4);
  assert.equal(t.rows.reduce((s, r) => s + r.count, 0) + t.others, records.length);
  assert.equal(topSponsors(records).rows.length, 4); // default n = 10
  assert.deepEqual(topSponsors([], 10), { rows: [], others: 0, otherSponsors: 0, sponsorCount: 0 });
  assert.deepEqual(topSponsors(records, 0).rows, []);
});

test("sponsorMix: all three groups with shares", () => {
  const mix = sponsorMix([
    rec({ sponsorClass: "INDUSTRY" }),
    rec({ sponsorClass: "INDUSTRY" }),
    rec({ sponsorClass: "FED" }),
    rec({ sponsorClass: null }),
  ]);
  assert.deepEqual(mix, [
    { group: "Industry", count: 2, share: 0.5 },
    { group: "Government & public bodies", count: 1, share: 0.25 },
    { group: "Universities, hospitals & other", count: 1, share: 0.25 },
  ]);
  assert.deepEqual(
    sponsorMix([]).map((m) => [m.group, m.count, m.share]),
    SPONSOR_ORDER.map((g) => [g, 0, 0]),
  );
});

// ---------------------------------------------------------------- interventions

test("interventionTypes: trials per type with plain-English labels", () => {
  const records = [
    rec({ interventions: [{ type: "DRUG", name: "a" }, { type: "DRUG", name: "b" }] }), // counts once
    rec({ interventions: [{ type: "DRUG", name: "a" }, { type: "DEVICE", name: "laser" }] }),
    rec({ interventions: [{ type: "PROCEDURE", name: "surgery" }, { type: null, name: "x" }] }),
    rec({ interventions: [{ type: "SOMETHING_NEW", name: "y" }, { type: "OTHER", name: "z" }] }),
    rec({ interventions: [] }),
    rec({ interventions: undefined }),
  ];
  assert.deepEqual(interventionTypes(records), [
    { type: "DRUG", label: "Drug", count: 2 },
    { type: "OTHER", label: "Other", count: 2 },
    { type: "DEVICE", label: "Device", count: 1 },
    { type: "PROCEDURE", label: "Procedure or surgery", count: 1 },
  ]);
  assert.deepEqual(interventionTypes([]), []);
  assert.deepEqual(Object.values(INTERVENTION_LABELS), [
    "Drug", "Device", "Behavioral", "Procedure or surgery", "Biological", "Dietary supplement", "Radiation",
    "Genetic", "Combination product", "Diagnostic test", "Other",
  ]);
  for (const r of RAW_RECORDS) for (const i of r.interventions) assert.ok(i.type in INTERVENTION_LABELS, i.type);
});

test("cleanInterventionName drops dosages, marks and stray punctuation", () => {
  const cases = {
    "Ivermectin 1% cream": "Ivermectin cream",
    "Ivermectin Cream, 1%": "Ivermectin Cream",
    "azelaic acid 15% gel": "azelaic acid gel",
    "Azelaic acid foam 15%": "Azelaic acid foam",
    "Oxymetazoline HCL Cream 1.0%": "Oxymetazoline HCL Cream",
    "doxycycline hyclate 20 mg twice daily": "doxycycline hyclate twice daily",
    "Pazopanib (5mg/ml)": "Pazopanib",
    "DFD-29 Extended Release Capsules (40 mg)": "DFD-29 Extended Release Capsules",
    "Oracea®": "Oracea",
    "Rossoseq™": "Rossoseq",
    "  Many   spaces  ": "Many spaces",
    "0.18% COL-118 facial gel": "COL-118 facial gel",
    "Brimonidine Topical Gel, 0.33 percent (Perrigo)": "Brimonidine Topical Gel, (Perrigo)",
    "Dupilumab 300 mg/2 mL": "Dupilumab",
    "Vitamin D 1000 IU": "Vitamin D",
    "Drug 10 mg/kg/day": "Drug",
    "Cream 5 mg/g twice daily": "Cream twice daily",
    "1927-nm Thulium Laser therapy": "1927-nm Thulium Laser therapy", // not a dosage
    "S5G4T-1": "S5G4T-1",
    "CD5024 1%": "CD5024",
    "Metronidazole Topical Gel 1%": "Metronidazole Topical Gel",
    "Tacrolimus 0,1%": "Tacrolimus",
    "1%": "",
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(cleanInterventionName(input), want, input);
  assert.equal(cleanInterventionName(null), "");
  // The key also drops form, route and salt words.
  assert.equal(interventionKey("Ivermectin 1% Cream"), "ivermectin");
  assert.equal(interventionKey("IVERMECTIN  CREAM"), "ivermectin");
  assert.equal(interventionKey("Oxymetazoline HCL Cream 1.0%"), "oxymetazoline");
  assert.equal(interventionKey("doxycycline hyclate 20 mg twice daily"), "doxycycline");
  assert.equal(interventionKey("Azelaic acid foam, 15% (BAY39-6251)"), "azelaic acid");
  assert.equal(interventionKey("Experimental: Secukinumab low dose"), "secukinumab");
  assert.equal(interventionKey("Cream"), "cream"); // nothing but a form word keeps it
});

test("isPlaceboName", () => {
  assert.equal(A.PLACEBO_LABEL, "Placebo or vehicle");
  for (const yes of ["Placebo", "placebo", "Matching placebo", "Placebo gel", "Vehicle", "Vehicle foam (0%)",
    "AGN-199201 Vehicle", "Vehicle to Oxymetazoline HCL Cream", "Placebo/Vehicle cream", "Oral placebo capsules",
    "Placebos"]) {
    assert.equal(isPlaceboName(yes), true, yes);
  }
  for (const no of ["Doxycycline", "Vehicular trauma survey", "Placebogenic", "Saline", "Sham laser", null]) {
    assert.equal(isPlaceboName(no), false, String(no));
  }
  assert.equal(isShamName("Sham laser"), true);
  assert.equal(isShamName("Shampoo"), false);
});

test("topInterventions: counts trials per normalized name; placebo reported separately", () => {
  const records = [
    rec({ interventions: [{ type: "DRUG", name: "Doxycycline" }, { type: "DRUG", name: "doxycycline 40 mg" }] }),
    rec({ interventions: [{ type: "DRUG", name: "Doxycycline" }, { type: "DRUG", name: "Placebo" }] }),
    rec({ interventions: [{ type: "DRUG", name: "doxycycline" }, { type: "DRUG", name: "Vehicle gel" }, { type: "DRUG", name: "placebo" }] }),
    rec({ interventions: [{ type: "DRUG", name: "ivermectin 1% cream" }, { type: "DRUG", name: "Ivermectin Cream, 1%" }] }),
    rec({ interventions: [{ type: "DRUG", name: "ivermectin cream 0.5%" }] }),
    rec({ interventions: [{ type: "OTHER", name: "No Intervention" }, { type: "DEVICE", name: "laser" }] }),
    rec({ interventions: [{ type: "DRUG", name: "1%" }, { type: "DRUG", name: null }, { type: "DRUG" }] }),
    rec({ interventions: [] }),
  ];
  const t = topInterventions(records, 2);
  assert.deepEqual(t.rows, [
    { name: "Doxycycline", count: 3, spellings: 1 }, // most common spelling wins
    { name: "Ivermectin cream", count: 2, spellings: 1 }, // one spelling after cleaning: kept, with a capital
  ]);
  assert.equal(t.placeboTrials, 2);
  assert.equal(t.shamTrials, 0);
  assert.equal(t.distinct, 3); // doxycycline, ivermectin, laser
  assert.equal(t.tiedAtCut, 0);
  assert.equal(topInterventions(records).rows.length, 3); // default n = 15
  assert.deepEqual(topInterventions(records).rows[2], { name: "Laser", count: 1, spellings: 1 });
  assert.deepEqual(topInterventions([]), { rows: [], placeboTrials: 0, shamTrials: 0, distinct: 0, tiedAtCut: 0 });
});

test("topInterventions: splits combined names, merges brand and form spellings, keeps controls apart", () => {
  const one = (...names) => rec({ interventions: names.map((name) => ({ type: "DRUG", name })) });
  const records = [
    one("Secukinumab and Placebo"), // an active drug next to a placebo still counts
    one("Secukinumab 300 mg"),
    one("Placebo to match secukinumab"), // a placebo for it does not
    one("Doxycycline (Oracea)"),
    one("Oracea® (doxycycline) Capsules"), // brand outside, generic in brackets
    one("Doxycycline"),
    one("doxycycline hyclate"),
    one("Sham laser", "Pulsed dye laser"), // sham is a control; "laser" never swallows longer names
    one("CD07805/47 gel/CD07805/47 Vehicle"), // "/" between digits is part of the code
    one("Tap water (placebo control)", "Medicinal water"),
    one("Etanercept combined with methotrexate or etanercept combined with placebo"),
  ];
  const t = topInterventions(records, 3);
  assert.deepEqual(t.rows, [
    { name: "Doxycycline", count: 4, spellings: 4 },
    { name: "Secukinumab", count: 2, spellings: 2 },
    { name: "CD07805/47 gel", count: 1, spellings: 1 }, // a name never merged keeps its own words
  ]);
  assert.equal(t.placeboTrials, 5);
  assert.equal(t.shamTrials, 1);
  assert.equal(t.tiedAtCut, 4); // etanercept, medicinal water, methotrexate, pulsed dye laser
  const all = topInterventions(records, 50).rows.map((r) => r.name);
  assert.deepEqual(all.slice(3), ["Etanercept", "Medicinal water", "Methotrexate", "Pulsed dye laser"]);
  for (const name of all) assert.ok(!isPlaceboName(name) && !isShamName(name), name);
  // Merged spellings are named by the plain one; "+" without spaces is part of a product name.
  const merged = topInterventions([one("Ivermectin cream"), one("ivermectin 1% lotion"), one("AO+Mist")]).rows;
  assert.deepEqual(merged, [{ name: "Ivermectin", count: 2, spellings: 2 }, { name: "AO+Mist", count: 1, spellings: 1 }]);
});

test("topInterventions on real data: one drug is one row, counted like a reader would", () => {
  const top = (slug, n = 3) => {
    const doc = DOCS.find((x) => x.entry.slug === slug).doc;
    return topInterventions(doc.trials, n).rows.map((r) => [r.name, r.count]);
  };
  // Rosacea: azelaic acid had been split into 13 bars and ivermectin into 7.
  assert.deepEqual(top("rosacea"), [["Azelaic acid", 21], ["Doxycycline", 18], ["Ivermectin", 13]]);
  // Psoriasis: secukinumab and adalimumab are named in more trials than etanercept.
  assert.deepEqual(top("psoriasis").map(([name]) => name), ["Secukinumab", "Adalimumab", "Etanercept"]);
});

// ---------------------------------------------------------------- recruitingSites

test("recruitingSites: open sites of recruiting, non-quiet trials, aggregated by point", () => {
  const records = [
    rec({
      id: "NCT00000101",
      status: "RECRUITING",
      primaryCompletion: "2027-06",
      sites: [
        site({ lat: 1, lon: 2, city: "A", country: "Aland", status: "RECRUITING" }),
        site({ lat: 1, lon: 2, city: "A", country: "Aland", status: null }), // same point, same trial
        site({ lat: 3, lon: 4, city: "B", country: "Bland", status: "COMPLETED" }), // closed site
        site({ lat: 5, lon: 6, city: "C", country: "Aland", status: "NOT_YET_RECRUITING" }),
      ],
    }),
    rec({
      id: "NCT00000102",
      status: "NOT_YET_RECRUITING",
      primaryCompletion: "2028",
      sites: [site({ lat: 1, lon: 2, city: "A2", country: "Aland", status: "ENROLLING_BY_INVITATION" }), site({ lat: 7, lon: 8, country: null })],
    }),
    rec({ id: "NCT00000103", status: "RECRUITING", primaryCompletion: "2020-01", sites: [site({ lat: 9, lon: 9 })] }), // quiet
    rec({ id: "NCT00000104", status: "COMPLETED", sites: [site({ lat: 9, lon: 9 })] }),
    rec({ id: "NCT00000105", status: "RECRUITING", primaryCompletion: "2027-01", sites: [] }),
    rec({ id: "NCT00000106", status: "RECRUITING", primaryCompletion: null, sites: [site({ lat: -1, lon: -2, country: "Cland", status: "WITHDRAWN" })] }),
  ];
  const r = recruitingSites(records, TODAY);
  assert.deepEqual(r.points, [
    // recruitingNow: trials that say RECRUITING at a site that is recruiting or gives no status
    { lat: 1, lon: 2, city: "A", country: "Aland", trials: 2, recruitingNow: 1 },
    { lat: 7, lon: 8, city: "Town", country: null, trials: 1, recruitingNow: 0 }, // trial not yet recruiting
    { lat: 5, lon: 6, city: "C", country: "Aland", trials: 1, recruitingNow: 0 }, // site not yet recruiting
  ]);
  assert.deepEqual(r.countries, [{ country: "Aland", sites: 2, trials: 2 }]);
  assert.equal(r.trialCount, 2);
  assert.equal(r.siteCount, 3);
  assert.equal(r.notYetPoints, 2);
  assert.deepEqual(recruitingSites([], TODAY), { points: [], countries: [], trialCount: 0, siteCount: 0, notYetPoints: 0 });
});

// ---------------------------------------------------------------- searchRecords

test("searchRecords: text, status group and phase filters", () => {
  const records = [
    rec({ id: "NCT01000001", title: "Laser for Keratosis Pilaris", status: "RECRUITING", phases: ["NA"], sponsor: "Johns Hopkins University",
      conditions: ["Keratosis Pilaris"] }),
    rec({ id: "NCT01000002", title: "Doxycycline in rosacea", status: "COMPLETED", phases: ["PHASE3"],
      interventions: [{ type: "DRUG", name: "Oracea" }] }),
    rec({ id: "NCT01000003", title: "Crème légère étude", status: "TERMINATED", phases: ["PHASE2"], conditions: ["Ocular Rosacea"] }),
    rec({ id: "NCT01000004", title: "All about allergies", status: "UNKNOWN", type: "OBSERVATIONAL", phases: [],
      conditions: ["Allergy"] }),
  ];
  const ids = (q) => searchRecords(records, q).map((r) => r.id.slice(-1));
  assert.deepEqual(ids({}), ["1", "2", "3", "4"]);
  assert.deepEqual(ids(undefined), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ text: "" }), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ text: "   " }), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ text: "LASER" }), ["1"]);
  assert.deepEqual(ids({ text: "rosacea" }), ["2", "3"]); // title and conditions
  assert.deepEqual(ids({ text: "oracea" }), ["2"]); // intervention names
  assert.deepEqual(ids({ text: "hopkins" }), ["1"]); // sponsor
  assert.deepEqual(ids({ text: "nct01000003" }), ["3"]); // id
  assert.deepEqual(ids({ text: "creme etude" }), ["3"]); // accents ignored, every word must match
  assert.deepEqual(ids({ text: "étude laser" }), []);
  assert.deepEqual(ids({ text: "all" }), ["4"]); // "all" is a real word in the text box
  assert.deepEqual(ids({ statusGroup: "Stopped early" }), ["3"]);
  assert.deepEqual(ids({ statusGroup: "Recruiting" }), ["1"]);
  assert.deepEqual(ids({ statusGroup: "all" }), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ statusGroup: "" }), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ phase: "Not phased" }), ["1", "4"]);
  assert.deepEqual(ids({ phase: "Phase 3" }), ["2"]);
  assert.deepEqual(ids({ phase: "All" }), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ text: "rosacea", statusGroup: "Completed", phase: "Phase 3" }), ["2"]);
  assert.deepEqual(ids({ text: "rosacea", statusGroup: "Recruiting" }), []);
  assert.deepEqual(searchRecords([], { text: "x" }), []);
  // Returns the same record objects, in input order.
  assert.equal(searchRecords(records, { text: "laser" })[0], records[0]);
});

// ---------------------------------------------------------------- real data invariants

test("real prebuilt data: every analysis adds up", () => {
  for (const { entry, doc } of DOCS) {
    const records = doc.trials;
    assert.equal(records.length, doc.count, entry.slug);
    assert.equal(records.length, entry.count, entry.slug);
    const s = summarize(records, TODAY);
    assert.equal(s.total, records.length);
    assert.equal(s.recruiting + s.active + s.completed + s.stopped + s.unknown, s.total, entry.slug);
    assert.ok(s.withResultsOfCompleted === null || (s.withResultsOfCompleted >= 0 && s.withResultsOfCompleted <= 1));
    assert.ok(s.industryShare >= 0 && s.industryShare <= 1);
    assert.ok(s.firstYear <= s.lastYear);

    const starts = startsByYear(records);
    assert.equal(starts.rows.reduce((a, r) => a + r.count, 0) + starts.undated, records.length, entry.slug);
    for (let i = 1; i < starts.rows.length; i += 1) assert.ok(starts.rows[i - 1].year <= starts.rows[i].year);

    const interventional = records.filter((r) => r.type === "INTERVENTIONAL").length;
    assert.equal(phaseByStatus(records).reduce((a, r) => a + r.count, 0), interventional, entry.slug);

    const quiet = quietListings(records, TODAY);
    assert.equal(quiet.length, s.quiet, entry.slug);
    for (const q of quiet) {
      assert.equal(statusGroup(q.record.status), "Recruiting");
      assert.ok(q.monthsOverdue >= 6);
    }
    for (let i = 1; i < quiet.length; i += 1) assert.ok(quiet[i - 1].monthsOverdue >= quiet[i].monthsOverdue);

    const mix = sponsorMix(records);
    assert.equal(mix.reduce((a, m) => a + m.count, 0), records.length);
    assert.ok(Math.abs(mix.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
    assert.equal(mix[0].share, s.industryShare);

    const top = topSponsors(records);
    assert.ok(top.rows.length <= 10);
    assert.equal(top.rows.reduce((a, r) => a + r.count, 0) + top.others, records.length);

    const ti = topInterventions(records);
    assert.ok(ti.rows.length <= 15 && ti.rows.length <= ti.distinct);
    assert.ok(ti.placeboTrials <= records.length);
    for (const row of ti.rows) assert.ok(!isPlaceboName(row.name), row.name);

    const sites = recruitingSites(records, TODAY);
    assert.ok(sites.trialCount <= s.recruiting - s.quiet, entry.slug);
    const keys = new Set(sites.points.map((p) => `${p.lat},${p.lon}`));
    assert.equal(keys.size, sites.points.length);
    for (const c of sites.countries) assert.ok(c.trials <= sites.trialCount && c.sites >= 1);

    assert.equal(searchRecords(records, {}).length, records.length);
    const byStatus = STATUS_ORDER.map((g) => searchRecords(records, { statusGroup: g }).length);
    assert.equal(byStatus.reduce((a, b) => a + b, 0), records.length);
    const byPhase = PHASE_ORDER.map((p) => searchRecords(records, { phase: p }).length);
    assert.equal(byPhase.reduce((a, b) => a + b, 0), records.length);
  }
});

test("real data: rosacea is prebuilt and analyses run on it", () => {
  const rosacea = DOCS.find((x) => x.entry.slug === "rosacea");
  assert.ok(rosacea, "rosacea.json is prebuilt");
  const s = summarize(rosacea.doc.trials, TODAY);
  assert.equal(s.total, rosacea.entry.count);
  assert.ok(s.total > 100);
  // Every quiet listing really is past its date by the rule's own arithmetic,
  // and every recruiting listing that is not quiet is not.
  for (const r of rosacea.doc.trials) {
    if (statusGroup(r.status) !== "Recruiting") continue;
    const end = parseDate(r.primaryCompletion, { end: true });
    if (!end) continue;
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth() + 6;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const deadline = new Date(Date.UTC(y, m, Math.min(end.getUTCDate(), last)));
    assert.equal(isQuiet(r, TODAY), TODAY > deadline, r.id);
  }
});

test("lookups ignore Object.prototype keys", () => {
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.equal(statusGroup(key), "Unknown", key);
    assert.equal(phaseGroup(rec({ phases: [key] })), "Not phased", key);
    assert.equal(interventionType(key), "OTHER", key);
    assert.deepEqual(interventionTypes([rec({ interventions: [{ type: key, name: "x" }] })]), [{ type: "OTHER", label: "Other", count: 1 }]);
  }
  assert.equal(interventionType("DRUG"), "DRUG");
  assert.doesNotThrow(() => summarize([rec({ status: "toString" })], TODAY));
});

test("functions that need today reject a missing or invalid date", () => {
  for (const fn of [summarize, quietListings, recruitingSites]) {
    assert.throws(() => fn([], undefined), TypeError);
    assert.throws(() => fn([], new Date("nope")), TypeError);
  }
  // A date string is accepted as a convenience.
  assert.equal(summarize([], "2026-10-25").total, 0);
});

test("analyze.js has no DOM or network dependencies", () => {
  const src = fs.readFileSync(path.join(ROOT, "site/js/analyze.js"), "utf8");
  for (const word of ["document", "window", "fetch(", "localStorage", "Date.now", "new Date()"]) {
    assert.ok(!src.includes(word), word);
  }
});
