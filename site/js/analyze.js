// Pure analysis functions over normalized trial Records (see normalize.js).
// No DOM, no fetch, no clock: anything that depends on the date takes
// `today` as a Date argument, so results are reproducible in tests.
//
// Counting conventions used throughout:
// - Every count is a count of trials (records), never of rows inside a trial,
//   unless the field name says otherwise (e.g. `sites`).
// - Rows with a zero count are left out of row arrays.
// - Shares are fractions 0..1, or null when the denominator is 0.

// ---------------------------------------------------------------- dates

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function utc(y, m, d) {
  // Date.UTC maps years 0..99 to 1900..1999; setUTCFullYear does not.
  const date = new Date(0);
  date.setUTCFullYear(y, m, d);
  return date;
}

function daysInMonth(y, m) {
  return utc(y, m + 1, 0).getUTCDate();
}

/**
 * "YYYY", "YYYY-MM" or "YYYY-MM-DD" to a Date at 00:00 UTC.
 * Missing parts default to the first month/day, or with {end: true} to the
 * last month/day ("2024" -> 2024-12-31, "2024-02" -> 2024-02-29). A full
 * date is returned as that day either way. Returns null for anything else,
 * including impossible dates such as "2023-02-30".
 */
export function parseDate(s, { end = false } = {}) {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  if (m[2] === undefined) return end ? utc(y, 11, 31) : utc(y, 0, 1);
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  if (m[3] === undefined) return utc(y, month, end ? daysInMonth(y, month) : 1);
  const day = Number(m[3]);
  if (day < 1 || day > daysInMonth(y, month)) return null;
  return utc(y, month, day);
}

/** Start year of a date string, or null. */
export function yearOf(s) {
  const d = parseDate(s);
  return d ? d.getUTCFullYear() : null;
}

function asToday(today) {
  const d = today instanceof Date ? today : typeof today === "string" ? parseDate(today) : null;
  if (!d || Number.isNaN(d.getTime())) throw new TypeError("today must be a valid Date");
  return d;
}

// ---------------------------------------------------------------- groups

export const PHASE_ORDER = [
  "Early phase 1",
  "Phase 1",
  "Phase 1/2",
  "Phase 2",
  "Phase 2/3",
  "Phase 3",
  "Phase 4",
  "Not phased",
];

const PHASE_LABEL = {
  EARLY_PHASE1: "Early phase 1",
  PHASE1: "Phase 1",
  PHASE2: "Phase 2",
  PHASE3: "Phase 3",
  PHASE4: "Phase 4",
};
const PHASE_RANK = { EARLY_PHASE1: 0, PHASE1: 1, PHASE2: 2, PHASE3: 3, PHASE4: 4 };

// Own-key lookup, so an unexpected value such as "toString" or "constructor"
// never matches a property inherited from Object.prototype.
const has = (obj, key) => typeof key === "string" && Object.hasOwn(obj, key);

/**
 * Phase group of a record. Observational and expanded-access records, and
 * records whose phases are [] or ["NA"], are "Not phased". PHASE1+PHASE2 is
 * "Phase 1/2", PHASE2+PHASE3 is "Phase 2/3"; any other combination (not used
 * by ClinicalTrials.gov) falls back to the highest phase listed.
 */
export function phaseGroup(record) {
  if (!record || record.type === "OBSERVATIONAL" || record.type === "EXPANDED_ACCESS") return "Not phased";
  const phases = (Array.isArray(record.phases) ? record.phases : []).filter((p) => has(PHASE_RANK, p));
  if (phases.length === 0) return "Not phased";
  const set = new Set(phases);
  if (set.has("PHASE1") && set.has("PHASE2")) return "Phase 1/2";
  if (set.has("PHASE2") && set.has("PHASE3")) return "Phase 2/3";
  const top = phases.reduce((a, b) => (PHASE_RANK[b] > PHASE_RANK[a] ? b : a));
  return PHASE_LABEL[top];
}

export const STATUS_ORDER = ["Recruiting", "Active, not recruiting", "Completed", "Stopped early", "Unknown"];

const STATUS_GROUP = {
  RECRUITING: "Recruiting",
  NOT_YET_RECRUITING: "Recruiting",
  ENROLLING_BY_INVITATION: "Recruiting",
  ACTIVE_NOT_RECRUITING: "Active, not recruiting",
  COMPLETED: "Completed",
  TERMINATED: "Stopped early",
  WITHDRAWN: "Stopped early",
  SUSPENDED: "Stopped early",
};

/** Plain-English status group; UNKNOWN, null and expanded-access statuses are "Unknown". */
export function statusGroup(status) {
  return has(STATUS_GROUP, status) ? STATUS_GROUP[status] : "Unknown";
}

/** The site statuses that count as open for recruitment. */
export const RECRUITING_STATUSES = ["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"];

export const SPONSOR_ORDER = ["Industry", "Government & public bodies", "Universities, hospitals & other"];

/**
 * Lead sponsor class to one of SPONSOR_ORDER. NIH, FED (U.S. federal) and
 * OTHER_GOV (any other country's government bodies, including public
 * hospitals) share "Government & public bodies": most OTHER_GOV sponsors are
 * not U.S. bodies, so the label must not say "U.S.".
 */
export function sponsorGroup(cls) {
  if (cls === "INDUSTRY") return "Industry";
  if (cls === "NIH" || cls === "FED" || cls === "OTHER_GOV") return "Government & public bodies";
  return "Universities, hospitals & other";
}

// ---------------------------------------------------------------- quiet listings

/** `d` plus `k` calendar months, the day clamped to the end of a shorter month (Jan 31 + 1 = Feb 28). */
function addMonths(d, k) {
  const total = d.getUTCMonth() + k;
  const y = d.getUTCFullYear() + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return utc(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m)));
}

/** The planned primary completion as a date: the day itself, or the end of the month or year given. */
function plannedCompletion(record) {
  return parseDate(record?.primaryCompletion, { end: true });
}

/**
 * Whole months from the planned primary completion date to `today`, the way
 * a reader counts them from the date shown: "2025-08-10" with today
 * 2026-10-25 gives 14. A "YYYY-MM" date counts from the last day of that
 * month and a "YYYY" date from 31 December, so a vague date is never
 * counted as later than it could be. 0 within the first month after the
 * date, negative while it is still ahead. null without a valid date.
 */
export function monthsOverdue(record, today) {
  const t = asToday(today);
  const pc = plannedCompletion(record);
  if (!pc) return null;
  let k = (t.getUTCFullYear() - pc.getUTCFullYear()) * 12 + (t.getUTCMonth() - pc.getUTCMonth());
  if (addMonths(pc, k) > t) k -= 1;
  return k;
}

/**
 * A listing that still says it is recruiting although its planned primary
 * completion date (for a month or year alone, the end of it) passed more
 * than `graceMonths` months before `today`. This usually means the record
 * was not updated, nothing more.
 */
export function isQuiet(record, today, graceMonths = 6) {
  const t = asToday(today);
  if (!record || statusGroup(record.status) !== "Recruiting") return false;
  const pc = plannedCompletion(record);
  return pc !== null && addMonths(pc, graceMonths) < t;
}

/** Quiet listings, most overdue first (then by id): [{record, monthsOverdue}]. */
export function quietListings(records, today, graceMonths = 6) {
  asToday(today);
  const out = [];
  for (const record of records) {
    if (isQuiet(record, today, graceMonths)) out.push({ record, monthsOverdue: monthsOverdue(record, today) });
  }
  out.sort((a, b) => {
    const da = plannedCompletion(a.record);
    const db = plannedCompletion(b.record);
    return da - db || compare(a.record.id, b.record.id);
  });
  return out;
}

// ---------------------------------------------------------------- summary

function compare(a, b) {
  a = a ?? "";
  b = b ?? "";
  return a < b ? -1 : a > b ? 1 : 0;
}

function median(values) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Headline numbers for a set of records.
 * - recruiting/active/completed/stopped/unknown: counts by statusGroup.
 * - withResults: trials with results posted on ClinicalTrials.gov.
 * - withResultsOfCompleted: share of completed interventional trials with
 *   posted results (completedInterventionalWithResults / completedInterventional).
 * - industryShare: share of trials whose lead sponsor is industry.
 * - quiet: number of quiet listings (isQuiet with the default 6 months).
 * - firstYear/lastYear: earliest and latest start year (may be a future,
 *   planned start).
 * - medianEnrollment: median enrollment (actual or planned) over trials with
 *   an enrollment above 0; withdrawn trials report 0 and are left out. May
 *   end in .5. enrollmentCounted is how many trials it covers;
 *   zeroEnrollment (listing 0) and missingEnrollment (no number) are the
 *   trials left out, so the page can say so.
 */
export function summarize(records, today) {
  asToday(today);
  const counts = { Recruiting: 0, "Active, not recruiting": 0, Completed: 0, "Stopped early": 0, Unknown: 0 };
  let withResults = 0;
  let completedInterventional = 0;
  let completedInterventionalWithResults = 0;
  let industry = 0;
  let quiet = 0;
  let firstYear = null;
  let lastYear = null;
  const enrollments = [];
  let zeroEnrollment = 0;
  let missingEnrollment = 0;
  for (const r of records) {
    const g = statusGroup(r.status);
    counts[g] += 1;
    if (r.hasResults) withResults += 1;
    if (g === "Completed" && r.type === "INTERVENTIONAL") {
      completedInterventional += 1;
      if (r.hasResults) completedInterventionalWithResults += 1;
    }
    if (sponsorGroup(r.sponsorClass) === "Industry") industry += 1;
    if (isQuiet(r, today)) quiet += 1;
    const y = yearOf(r.start);
    if (y !== null) {
      if (firstYear === null || y < firstYear) firstYear = y;
      if (lastYear === null || y > lastYear) lastYear = y;
    }
    if (typeof r.enrollment === "number" && Number.isFinite(r.enrollment) && r.enrollment > 0) {
      enrollments.push(r.enrollment);
    } else if (r.enrollment === 0) {
      zeroEnrollment += 1;
    } else {
      missingEnrollment += 1;
    }
  }
  const total = records.length;
  return {
    total,
    recruiting: counts.Recruiting,
    active: counts["Active, not recruiting"],
    completed: counts.Completed,
    stopped: counts["Stopped early"],
    unknown: counts.Unknown,
    withResults,
    withResultsOfCompleted: completedInterventional ? completedInterventionalWithResults / completedInterventional : null,
    completedInterventional,
    completedInterventionalWithResults,
    industryShare: total ? industry / total : null,
    quiet,
    firstYear,
    lastYear,
    medianEnrollment: median(enrollments),
    enrollmentCounted: enrollments.length,
    zeroEnrollment,
    missingEnrollment,
  };
}

// ---------------------------------------------------------------- charts

function countBy(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * Trials started per year and phase group.
 * {rows: [{year, phase, count}] sorted by year then PHASE_ORDER, undated}
 * where undated counts records with no valid start date. Years with no
 * trials have no rows.
 */
export function startsByYear(records) {
  const m = new Map();
  let undated = 0;
  for (const r of records) {
    const year = yearOf(r.start);
    if (year === null) {
      undated += 1;
      continue;
    }
    const phase = phaseGroup(r);
    const key = `${year}|${phase}`;
    const row = m.get(key) ?? { year, phase, count: 0 };
    row.count += 1;
    m.set(key, row);
  }
  const rows = [...m.values()].sort(
    (a, b) => a.year - b.year || PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
  );
  return { rows, undated };
}

/** Interventional trials by phase group and status group: [{phase, status, count}] in PHASE_ORDER, STATUS_ORDER. */
export function phaseByStatus(records) {
  const m = new Map();
  for (const r of records) {
    if (r.type !== "INTERVENTIONAL") continue;
    const phase = phaseGroup(r);
    const status = statusGroup(r.status);
    const key = `${phase}|${status}`;
    const row = m.get(key) ?? { phase, status, count: 0 };
    row.count += 1;
    m.set(key, row);
  }
  return [...m.values()].sort(
    (a, b) =>
      PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) ||
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
}

function cleanSpaces(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * Top lead sponsors by number of trials.
 * {rows: [{sponsor, group, count}], others, otherSponsors, sponsorCount}
 * - Names are merged ignoring case and repeated spaces; the most common
 *   spelling is shown. group comes from the sponsor's most common class.
 * - rows are sorted by count, then name; ties at the cut are decided by name.
 * - others: trials not in rows (smaller sponsors and trials with no sponsor
 *   named), so rows' counts + others = records.length.
 * - otherSponsors: named sponsors not in rows; sponsorCount: all named sponsors.
 */
export function topSponsors(records, n = 10) {
  const m = new Map();
  for (const r of records) {
    if (typeof r.sponsor !== "string" || !cleanSpaces(r.sponsor)) continue;
    const name = cleanSpaces(r.sponsor);
    const key = name.toLowerCase();
    const e = m.get(key) ?? { key, count: 0, names: new Map(), classes: new Map() };
    e.count += 1;
    e.names.set(name, (e.names.get(name) ?? 0) + 1);
    e.classes.set(r.sponsorClass ?? null, (e.classes.get(r.sponsorClass ?? null) ?? 0) + 1);
    m.set(key, e);
  }
  const all = [...m.values()].map((e) => ({
    sponsor: mostCommon(e.names),
    group: sponsorGroup(mostCommon(e.classes)),
    count: e.count,
  }));
  all.sort((a, b) => b.count - a.count || compare(a.sponsor.toLowerCase(), b.sponsor.toLowerCase()) || compare(a.sponsor, b.sponsor));
  const rows = all.slice(0, Math.max(0, n));
  const shown = rows.reduce((s, r) => s + r.count, 0);
  return { rows, others: records.length - shown, otherSponsors: all.length - rows.length, sponsorCount: all.length };
}

function mostCommon(counts) {
  let best = null;
  let bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount || (c === bestCount && compare(String(k), String(best)) < 0)) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

/** Share of trials by sponsor group: [{group, count, share}] for all three groups in SPONSOR_ORDER. */
export function sponsorMix(records) {
  const m = countBy(records, (r) => sponsorGroup(r.sponsorClass));
  const total = records.length;
  return SPONSOR_ORDER.map((group) => {
    const count = m.get(group) ?? 0;
    return { group, count, share: total ? count / total : 0 };
  });
}

export const INTERVENTION_LABELS = {
  DRUG: "Drug",
  DEVICE: "Device",
  BEHAVIORAL: "Behavioral",
  PROCEDURE: "Procedure or surgery",
  BIOLOGICAL: "Biological",
  DIETARY_SUPPLEMENT: "Dietary supplement",
  RADIATION: "Radiation",
  GENETIC: "Genetic",
  COMBINATION_PRODUCT: "Combination product",
  DIAGNOSTIC_TEST: "Diagnostic test",
  OTHER: "Other",
};

/** An intervention's type as a key of INTERVENTION_LABELS; missing or unrecognised types are "OTHER". */
export function interventionType(type) {
  return has(INTERVENTION_LABELS, type) ? type : "OTHER";
}

/**
 * Trials testing each intervention type: [{type, label, count}], most
 * common first. A trial counts once per type however many interventions of
 * that type it has; missing or unrecognised types count as OTHER. Trials
 * with no interventions listed are not counted.
 */
export function interventionTypes(records) {
  const m = new Map();
  for (const r of records) {
    const types = new Set();
    for (const i of r.interventions ?? []) types.add(interventionType(i?.type));
    for (const t of types) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m]
    .map(([type, count]) => ({ type, label: INTERVENTION_LABELS[type], count }))
    .sort((a, b) => b.count - a.count || compare(a.label, b.label));
}

const MARKS_RE = /[®™©℠]/g;
const DOSE_RE =
  /(^|[^\w.])\d+(?:[.,]\d+)?\s*(?:%|percent\b|(?:mg|mcg|µg|μg|ug|g|kg|ml|l|iu|units?|mmol|meq)(?:\s*\/\s*(?:kg|ml|m2|day|d|dose|drop|g|l|h|hr|hour|week|wk|spray|actuation)\b)*\b)/gi;
/** The bucket placebo and vehicle controls are reported under (see topInterventions). */
export const PLACEBO_LABEL = "Placebo or vehicle";

const PLACEBO_RE = /\b(?:placebos?|vehicles?)\b/i;
const SHAM_RE = /\bsham\b/i;
const NO_INTERVENTION_RE = /^(?:no (?:intervention|treatment)\b|none$|n\/a$)/i;

/**
 * Clean an intervention name for display and grouping: drop ®/™ marks and
 * dosages ("1%", "100 mg", "10 mg/kg"), empty brackets left behind, stray
 * punctuation at the ends, and repeated spaces. Keeps the original case.
 * "Ivermectin Cream, 1%" -> "Ivermectin Cream".
 */
export function cleanInterventionName(name) {
  if (typeof name !== "string") return "";
  let s = name.replace(MARKS_RE, " ");
  s = s.replace(DOSE_RE, "$1");
  for (let i = 0; i < 3; i += 1) {
    s = s
      .replace(/\(\s*[,;:/+&-]*\s*\)/g, " ")
      .replace(/\[\s*[,;:/+&-]*\s*\]/g, " ")
      .replace(/\s+([,;:)\]])/g, "$1")
      .replace(/([(\[])\s+/g, "$1")
      .replace(/([,;:])(?:\s*[,;:])+/g, "$1");
  }
  return cleanSpaces(s).replace(/^[\s,;:/+&.-]+|[\s,;:/+&.-]+$/g, "");
}

// Words that describe a product's form, route, salt, schedule or role in the
// trial rather than what it is: "Ivermectin cream", "oral ivermectin" and
// "Ivermectin (reference)" are all ivermectin.
const FORM_WORDS = [
  "modified release", "extended release", "delayed release", "immediate release", "sustained release",
  "prefilled syringe", "pre-filled syringe", "auto-injector", "autoinjector", "solution for injection",
  "once daily", "twice daily", "once a day", "twice a day", "every other week", "every week", "every day",
  "low dose", "high dose", "half dose", "standard dose", "dose tapering", "add-on therapy",
  "cream", "creams", "gel", "gels", "foam", "foams", "ointment", "lotion", "emulsion", "solution", "suspension",
  "spray", "shampoo", "patch", "paste", "powder", "drops", "topical", "topically", "oral", "orally", "tablet",
  "tablets", "capsule", "capsules", "caps", "pill", "pills", "injection", "injections", "injectable", "infusion",
  "intravenous", "subcutaneous", "intramuscular", "s.c", "i.v", "sc", "iv", "pen", "syringe", "facial",
  "cutaneous", "ophthalmic", "mr", "er", "xr", "sr", "hydrochloride", "hcl", "hyclate", "monohydrate",
  "tartrate", "mesylate", "maleate", "usp", "generic", "originator", "reference", "test", "product",
  "daily", "bid", "qd", "monotherapy", "treatment", "therapy", "regimen", "arm", "group", "dose", "dosing",
];
const FORM_RE = new RegExp(
  `(?<![\\w-])(?:${FORM_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})(?![\\w-])\\.?`,
  "gi",
);
// Labels some listings put before the name: "Experimental: X", "1=X", "Arm A: X".
const ROLE_PREFIX_RE =
  /^\s*(?:(?:experimental|active comparator|placebo comparator|sham comparator|comparator|investigational arm|control arm|reference|test|arm\s*[a-z0-9]{1,3}|group\s*[a-z0-9]{1,3}|\d{1,2})\s*[:=]|(?:investigational|control) arm\s*[-–])\s*/i;
// Where a listing names several interventions in one string.
// "+" and "&" only with a space beside them, so product names such as
// "AO+Mist" stay whole.
const CONNECTOR_RE =
  /\s*(?:\s[+&]|[+&]\s|;|,\s+|(?<!\d)\/|\/(?!\d)|\s(?:and|plus|or|vs\.?|versus|then|followed by|combined with|in combination with|together with|in conjunction with)\s)\s*/i;
const STOP_RE = /^(?:of|the|a|an|for|to|with|in|by|via|on|at|and|or)$/i;
// Generic words never used to merge longer names ("laser" must not swallow
// "Pulsed dye laser").
const GENERIC_TERMS = new Set([
  "laser", "lasers", "light", "diet", "water", "saline", "control", "standard", "usual care", "standard of care",
  "observation", "survey", "education", "combination", "placebo", "vehicle", "sham",
]);

// Keeps the case it is given, so it serves for keys and for display names.
function formless(s) {
  return cleanSpaces(s.replace(FORM_RE, " "))
    .split(" ")
    .filter((w, i, a) => !(STOP_RE.test(w) && (i === 0 || i === a.length - 1)))
    .join(" ")
    .replace(/^[\s,;:/+&.()\[\]-]+|[\s,;:/+&.()\[\]-]+$/g, "");
}

/**
 * Grouping key for one intervention name: cleaned, case-folded and without
 * form, route or salt words. "Ivermectin 1% Cream" and "oral ivermectin"
 * give "ivermectin". A name that is nothing but such words keeps them.
 */
export function interventionKey(name) {
  const clean = cleanInterventionName(name).replace(ROLE_PREFIX_RE, "").toLowerCase();
  const outer = cleanSpaces(clean.replace(/\([^()]*\)|\[[^\[\]]*\]/g, " "));
  return formless(outer) || cleanSpaces(outer);
}

/** True for placebo and vehicle controls ("Placebo", "Vehicle cream", "AGN-199201 Vehicle"...). */
export function isPlaceboName(name) {
  return typeof name === "string" && PLACEBO_RE.test(name);
}

/** True for sham controls ("Sham laser", "Sham acupuncture"), the device or procedure version of a placebo. */
export function isShamName(name) {
  return typeof name === "string" && SHAM_RE.test(name);
}

/**
 * Break one listed name into the parts it names. Splits on "+", "&", ";",
 * ", ", "/" (not between digits, so "CD07805/47" stays whole) and connecting
 * words ("and", "plus", "or", "vs", "followed by", "combined with"...),
 * outside brackets. Each part: {text, inner, key}, where inner is the text
 * inside its brackets (often a brand or generic name) and key its
 * interventionKey.
 */
function nameParts(raw) {
  const clean = cleanInterventionName(raw).replace(ROLE_PREFIX_RE, "");
  if (!clean) return [];
  // Hold bracketed text aside so connectors inside brackets do not split.
  const groups = [];
  const outer = clean.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (_, a, b) => {
    groups.push(a ?? b);
    return ` \u0000${groups.length - 1}\u0000 `;
  });
  const parts = [];
  for (const piece of outer.split(new RegExp(CONNECTOR_RE.source, "gi"))) {
    if (!piece) continue;
    const inner = [];
    const text = cleanSpaces(piece.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      inner.push(groups[Number(i)]);
      return " ";
    })).replace(/^[\s,;:/+&.-]+|[\s,;:/+&.-]+$/g, "");
    if (!text && inner.length === 0) continue;
    const lower = text.toLowerCase();
    parts.push({ text, inner: inner.join(" "), key: formless(lower) || lower });
  }
  return parts;
}

function wordRe(term) {
  return new RegExp(`(?<![\\w-])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
}

/**
 * Named interventions tested most often, counting trials.
 * {rows: [{name, count, spellings}], placeboTrials, shamTrials, distinct, tiedAtCut}
 * - Each listed name is split into the interventions it names (see
 *   nameParts); placebo and vehicle parts, and sham parts, are controls:
 *   they are not ranked, and placeboTrials / shamTrials count the trials
 *   that list at least one. "Secukinumab and placebo" ranks secukinumab;
 *   "Placebo for ivermectin cream" is a placebo.
 * - Parts are grouped by key, ignoring dose, form, route and salt
 *   ("Ivermectin cream, 1%" and "oral ivermectin" are "ivermectin").
 * - A name that is used on its own in at least two trials (a "term", such
 *   as "doxycycline") also collects longer names that contain it, including
 *   inside brackets: "Doxycycline (Oracea)", "Oracea (doxycycline)" and
 *   "COL-101 (doxycycline, USP) capsules" all count as doxycycline. A part
 *   that contains several terms counts once under each.
 * - name is the most common spelling used on its own (first letter
 *   capitalised if it was all lower case); spellings is how many different
 *   cleaned names were merged into the row.
 * - "No intervention" style names are skipped.
 * - distinct: number of distinct ranked names; tiedAtCut: how many names
 *   that are not shown have the same count as the last row shown.
 */
export function topInterventions(records, n = 15) {
  // Pass 1: split every name and find the terms.
  const perRecord = [];
  const standalone = new Map(); // key -> Set of record indexes using it on its own
  records.forEach((r, idx) => {
    const items = [];
    for (const i of r.interventions ?? []) {
      const raw = i?.name;
      if (typeof raw !== "string") continue;
      const parts = nameParts(raw);
      // "Tap water (placebo control)", "E6005 ointment (vehicle)": a control
      // word in brackets makes the whole name a control.
      const control = parts.some((p) => PLACEBO_RE.test(p.inner)) ? "placebo" : parts.some((p) => SHAM_RE.test(p.inner)) ? "sham" : null;
      items.push({ raw, parts, control });
      if (control) continue;
      for (const p of parts) {
        if (!p.key || p.inner || PLACEBO_RE.test(p.text) || SHAM_RE.test(p.text)) continue;
        if (!standalone.has(p.key)) standalone.set(p.key, new Set());
        standalone.get(p.key).add(idx);
      }
    }
    perRecord.push(items);
  });
  let terms = [...standalone]
    .filter(([key, ids]) => {
      const words = key.split(" ").length;
      return ids.size >= 2 && words <= 3 && !GENERIC_TERMS.has(key) && (words > 1 || key.length >= 6) && /[a-z]{3}/.test(key);
    })
    .map(([key]) => ({ key, re: wordRe(key) }));
  // A term that contains a shorter term ("fmx103 minocycline") folds into it.
  terms = terms
    .filter((t) => !terms.some((u) => u.key.length < t.key.length && u.re.test(t.key)))
    .sort((a, b) => b.key.length - a.key.length || compare(a.key, b.key));

  // Pass 2: count trials per key.
  const m = new Map();
  let placeboTrials = 0;
  let shamTrials = 0;
  perRecord.forEach((items) => {
    let placebo = false;
    let sham = false;
    const seen = new Set();
    for (const { raw, parts, control } of items) {
      if (control === "placebo") placebo = true;
      if (control === "sham") sham = true;
      if (control) continue;
      for (const p of parts) {
        if (PLACEBO_RE.test(p.text)) {
          placebo = true;
          continue;
        }
        if (SHAM_RE.test(p.text)) {
          sham = true;
          continue;
        }
        if (!p.key || NO_INTERVENTION_RE.test(p.key)) continue;
        // Terms found in the part, longest first, without overlaps.
        let hay = ` ${p.key} ${p.inner.toLowerCase()} `;
        const keys = [];
        for (const t of terms) {
          if (t.key === p.key || t.re.test(hay)) {
            keys.push(t.key);
            hay = hay.replace(t.re, " ");
          }
        }
        if (keys.length === 0) keys.push(p.key);
        for (const key of keys) {
          const e = m.get(key) ?? { key, count: 0, exact: new Map(), spellings: new Set() };
          if (!seen.has(key)) {
            seen.add(key);
            e.count += 1;
          }
          e.spellings.add(cleanInterventionName(raw).toLowerCase());
          if (p.key === key && !p.inner) e.exact.set(p.text, (e.exact.get(p.text) ?? 0) + 1);
          m.set(key, e);
        }
      }
    }
    if (placebo) placeboTrials += 1;
    if (sham) shamTrials += 1;
  });
  const all = [...m.values()].sort((a, b) => b.count - a.count || compare(a.key, b.key));
  const rows = all.slice(0, Math.max(0, n)).map((e) => {
    // A row that merged several spellings is named by the plain one
    // ("Ivermectin" for "Ivermectin cream" and "ivermectin 1%"); a name that
    // was never merged keeps its own words ("CeraVe SA Smoothing Cream").
    const plain = new Map();
    if (e.spellings.size > 1) {
      for (const [text, c] of e.exact) {
        const bare = formless(text);
        if (bare.toLowerCase() === e.key) plain.set(bare, (plain.get(bare) ?? 0) + c);
      }
    }
    let name = plain.size ? mostCommon(plain) : e.exact.size ? mostCommon(e.exact) : e.key;
    if (name === name.toLowerCase()) name = name.charAt(0).toUpperCase() + name.slice(1);
    return { name, count: e.count, spellings: e.spellings.size };
  });
  const last = rows.at(-1);
  const tiedAtCut = last ? all.slice(rows.length).filter((e) => e.count === last.count).length : 0;
  return { rows, placeboTrials, shamTrials, distinct: all.length, tiedAtCut };
}

// ---------------------------------------------------------------- map

/**
 * Where someone could take part: sites of trials whose statusGroup is
 * "Recruiting", leaving out quiet listings, and only sites whose own status
 * is null or a recruiting status.
 * {points: [{lat, lon, city, country, trials, recruitingNow}], countries: [{country, sites, trials}],
 *  trialCount, siteCount, notYetPoints}
 * - points merge identical lat/lon; trials counts distinct trials there.
 *   recruitingNow counts those whose listing says RECRUITING and whose site
 *   says RECRUITING or gives no status; the rest are not yet recruiting or
 *   enrol by invitation only. notYetPoints: points with recruitingNow 0.
 *   Sorted by trials (most first), so small dots draw on top of big ones.
 *   city/country come from the first site seen at that point.
 * - countries: sites = distinct points in the country, trials = distinct
 *   trials with a site there; most trials first. Sites with no country are
 *   in points but not in countries.
 * - trialCount: trials with at least one such site; siteCount: points.length.
 */
export function recruitingSites(records, today) {
  asToday(today);
  const points = new Map();
  const countries = new Map();
  const trials = new Set();
  for (const r of records) {
    if (statusGroup(r.status) !== "Recruiting" || isQuiet(r, today)) continue;
    for (const s of r.sites ?? []) {
      if (!s || typeof s.lat !== "number" || typeof s.lon !== "number") continue;
      if (s.status != null && !RECRUITING_STATUSES.includes(s.status)) continue;
      const key = `${s.lat},${s.lon}`;
      const p = points.get(key) ?? { lat: s.lat, lon: s.lon, city: s.city ?? null, country: s.country ?? null, ids: new Set(), now: new Set() };
      p.ids.add(r.id);
      if (r.status === "RECRUITING" && (s.status == null || s.status === "RECRUITING")) p.now.add(r.id);
      points.set(key, p);
      if (s.country) {
        const c = countries.get(s.country) ?? { country: s.country, points: new Set(), ids: new Set() };
        c.points.add(key);
        c.ids.add(r.id);
        countries.set(s.country, c);
      }
      trials.add(r.id);
    }
  }
  const pointRows = [...points.values()]
    .map(({ ids, now, ...p }) => ({ ...p, trials: ids.size, recruitingNow: now.size }))
    .sort((a, b) => b.trials - a.trials || b.lat - a.lat || a.lon - b.lon);
  const countryRows = [...countries.values()]
    .map((c) => ({ country: c.country, sites: c.points.size, trials: c.ids.size }))
    .sort((a, b) => b.trials - a.trials || b.sites - a.sites || compare(a.country, b.country));
  return {
    points: pointRows,
    countries: countryRows,
    trialCount: trials.size,
    siteCount: pointRows.length,
    notYetPoints: pointRows.filter((p) => p.recruitingNow === 0).length,
  };
}

// ---------------------------------------------------------------- table filter

const haystacks = new WeakMap();

function fold(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function haystack(r) {
  let h = haystacks.get(r);
  if (h === undefined) {
    const parts = [r.id, r.title, r.sponsor, ...(r.conditions ?? []), ...(r.interventions ?? []).map((i) => i?.name)];
    h = fold(parts.filter((p) => typeof p === "string").join("\n"));
    haystacks.set(r, h);
  }
  return h;
}

function isAll(v) {
  return v === undefined || v === null || v === "" || (typeof v === "string" && v.toLowerCase() === "all");
}

/**
 * Filter records for the trial table. Returns the matching records in their
 * original order.
 * - text: every word must appear (ignoring case and accents) in the id,
 *   title, sponsor, conditions or intervention names.
 * - statusGroup: one of STATUS_ORDER; phase: one of PHASE_ORDER; empty,
 *   null or "all" means no filter. An empty or missing text means no filter.
 */
export function searchRecords(records, { text, statusGroup: group, phase } = {}) {
  const words = text == null ? [] : fold(text).split(/\s+/).filter(Boolean);
  const wantStatus = isAll(group) ? null : group;
  const wantPhase = isAll(phase) ? null : phase;
  return records.filter((r) => {
    if (wantStatus !== null && statusGroup(r.status) !== wantStatus) return false;
    if (wantPhase !== null && phaseGroup(r) !== wantPhase) return false;
    if (words.length) {
      const h = haystack(r);
      for (const w of words) if (!h.includes(w)) return false;
    }
    return true;
  });
}
