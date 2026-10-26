// Reduce a raw ClinicalTrials.gov API v2 study to the Record the site uses.
//
// This is a line-for-line port of normalize() in scripts/fetch_trials.py,
// which is the reference. tests/test_contract.py runs both on every raw
// fixture and on hand-made edge cases and requires identical output.
//
// Three places where a naive port would disagree with Python, and how this
// file matches it:
//
// 1. Truthiness. Python's `x or default` treats "", 0, [], {} and None as
//    false; JavaScript treats [] and {} as true. pyTruthy() copies Python.
// 2. Summary truncation. Python measures and slices strings in code points;
//    JavaScript strings are UTF-16, so an emoji counts as 2. truncateSummary()
//    works on code points (lone surrogates count as one, as in Python).
//    str.strip() uses Python's whitespace set, which differs from
//    String.prototype.trim(): Python strips U+001C..U+001F and U+0085, JS
//    strips U+FEFF. pyStrip() uses Python's set.
// 3. Rounding. Python's round(x, 2) rounds the exact binary value of x and
//    breaks exact ties to even; Math.round(x * 100) / 100 does neither.
//    pyRound2() uses toFixed(2) (exact, ties away from zero) and fixes the
//    only exact ties a double can hold at 2 decimals: values whose fraction
//    is k/8 with k odd (.125, .375, .625, .875). So 0.125 -> 0.12 and
//    -0.125 -> -0.12 (Python) where toFixed would give 0.13 / -0.13, while
//    2.675 -> 2.67 and 1.005 -> 1 because those doubles sit just below the
//    tie. Python returns -0.0 for small negatives (round(-0.001, 2)); so does
//    this function, and JSON.stringify writes it as 0 (Python writes -0.0);
//    the two parse to equal numbers.

export const SUMMARY_CHARS = 600;

// Every code point for which Python's str.isspace() is true (Python 3.10+).
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Python truthiness: None, False, 0, "", [], {} are false. */
export function pyTruthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0; // NaN is truthy in Python
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Python `a or b`. */
function or(a, b) {
  return pyTruthy(a) ? a : b;
}

/** Python dict.get(key): missing or undefined becomes null. */
function get(obj, key) {
  const v = obj == null ? undefined : obj[key];
  return v === undefined ? null : v;
}

/** Python dict.get(key, {}) used as a module: absent or null becomes {}. */
function mod(obj, key) {
  const v = get(obj, key);
  return v !== null && typeof v === "object" ? v : {};
}

/** Python str.strip() with no arguments. */
export function pyStrip(s) {
  return String(s).replace(PY_STRIP, "");
}

/**
 * Python: if len(s) > 600: s = s[:600].rsplit(" ", 1)[0] + "…"
 * Lengths and slices are in code points, like Python.
 */
export function truncateSummary(s, limit = SUMMARY_CHARS) {
  // UTF-16 length is >= code point length, so short strings need no work.
  if (s.length <= limit) return s;
  const points = Array.from(s);
  if (points.length <= limit) return s;
  const head = points.slice(0, limit).join("");
  const cut = head.lastIndexOf(" ");
  return (cut === -1 ? head : head.slice(0, cut)) + "…";
}

/** Python round(x, 2) for a float: correctly rounded, ties to even. */
export function pyRound2(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return x;
  if (Number.isInteger(x)) return x;
  const a = Math.abs(x);
  if (a >= 1e21) return x; // toFixed switches to exponent form; already integral
  let n;
  const eighths = a * 8; // exact: multiplying by a power of two
  if (Number.isInteger(eighths) && eighths % 2 === 1) {
    // Exact tie at the third decimal (…125, …375, …625, …875): go to even.
    const lo = Math.floor(a * 100); // a * 100 is exact here
    n = lo % 2 === 0 ? lo : lo + 1;
    const r = n / 100;
    return x < 0 ? -r : r;
  }
  const r = Number(a.toFixed(2));
  return x < 0 ? -r : r;
}

function date(struct) {
  return get(or(struct, {}), "date");
}

/** Normalize one raw API v2 study. Mirrors fetch_trials.normalize(). */
export function normalize(study) {
  const p = mod(study, "protocolSection");
  const ident = mod(p, "identificationModule");
  const status = mod(p, "statusModule");
  const design = mod(p, "designModule");
  const lead = mod(mod(p, "sponsorCollaboratorsModule"), "leadSponsor");

  let summary = pyStrip(or(get(mod(p, "descriptionModule"), "briefSummary"), ""));
  summary = truncateSummary(summary);

  const sites = [];
  const locations = get(mod(p, "contactsLocationsModule"), "locations") ?? [];
  for (const loc of locations) {
    const geo = get(loc, "geoPoint");
    if (!pyTruthy(geo) || get(geo, "lat") === null || get(geo, "lon") === null) continue;
    sites.push({
      lat: pyRound2(geo.lat),
      lon: pyRound2(geo.lon),
      city: get(loc, "city"),
      country: get(loc, "country"),
      status: get(loc, "status"),
    });
  }

  const pc = get(status, "primaryCompletionDateStruct");
  return {
    id: get(ident, "nctId"),
    title: or(or(get(ident, "briefTitle"), get(ident, "officialTitle")), ""),
    status: get(status, "overallStatus"),
    whyStopped: get(status, "whyStopped"),
    type: get(design, "studyType"),
    phases: copyList(or(get(design, "phases"), [])),
    sponsor: get(lead, "name"),
    sponsorClass: get(lead, "class"),
    enrollment: get(or(get(design, "enrollmentInfo"), {}), "count"),
    start: date(get(status, "startDateStruct")),
    primaryCompletion: date(pc),
    primaryCompletionType: get(or(pc, {}), "type"),
    completion: date(get(status, "completionDateStruct")),
    firstPosted: date(get(status, "studyFirstPostDateStruct")),
    lastUpdate: date(get(status, "lastUpdatePostDateStruct")),
    verified: get(status, "statusVerifiedDate"),
    conditions: copyList(or(get(mod(p, "conditionsModule"), "conditions"), [])),
    interventions: (or(get(mod(p, "armsInterventionsModule"), "interventions"), [])).map((i) => ({
      type: get(i, "type"),
      name: get(i, "name"),
    })),
    hasResults: pyTruthy(get(study, "hasResults")),
    summary,
    sites,
  };
}

function copyList(v) {
  return Array.isArray(v) ? v.slice() : v;
}
