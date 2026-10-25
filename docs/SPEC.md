# v1 spec: Clinical Trials Explorer

This is the build contract for v1. Every module below has one owner; build
against the interfaces exactly as written.

## Product

A free static site that shows the research landscape for a condition, for
curious non-academics, patients' families, journalists and early researchers.
ClinicalTrials.gov is good at finding one trial; this site shows the whole
picture. Two pages:

1. **Explorer** (`site/index.html`): search any condition, see its landscape.
2. **Story** (`site/story.html`): "The skin conditions research forgot", a
   narrative built from the prebuilt dermatology data (keratosis pilaris vs
   rosacea and four comparison conditions).

### Hard rules

- **Not medical advice.** Every page carries a short, visible notice: the site
  shows what researchers are studying; it does not recommend treatments or say
  whether a trial is right for anyone; talk to a doctor. Never use words like
  "best treatment", "works", "effective", "cure" about any intervention. Say
  "tested", "studied".
- A stale listing is framed as "not updated", never as wrongdoing.
- **No innerHTML with data.** Every string from the API or data files goes into
  the DOM through `textContent`, `createElement`, or Plot (which escapes text).
  Trial links are built only from IDs matching `/^NCT\d{8}$/`.
- **No silent caps.** If anything is truncated (pages fetched, rows shown, top
  N), the UI says so with numbers.
- Every number in the UI is computed from data at runtime. Nothing hard-coded
  except curated text in `site/data/story.json`.
- No build step, no npm at runtime. Plain ES modules. Libraries are vendored in
  `site/vendor/`: `d3.min.js` (d3 7.9.0, global `d3`), `plot.umd.min.js`
  (Observable Plot 0.6.17, global `Plot`, needs d3 loaded first),
  `topojson-client.min.js` (global `topojson`), `countries-110m.json`
  (world-atlas 2.0.2). Load them with classic `<script>` tags before the
  module script.
- Works at 360px wide (16px side gutters, no horizontal page scroll), and in
  light and dark mode (`prefers-color-scheme`). Charts re-render on resize.
- Accessible: semantic headings, labelled form controls, keyboard usable,
  every chart has a text summary (`aria-label` or a caption sentence with its
  key number), colour is never the only carrier of meaning, contrast AA.

## Data

### Prebuilt files (written by `scripts/fetch_trials.py`)

- `site/data/index.json`: `{fetched, conditions: [{slug, label, group, count}]}`
- `site/data/<slug>.json`: `{slug, label, query, fetched, count, trials: [Record]}`
- `site/data/changes.json`: `{updated, baseline, events: [{date, id, title, condition, from, to}]}`.
  `baseline: true` means the first run; there are no events yet. Say "change
  tracking started on <date>".
- `site/data/trials.sqlite3`: built in CI by `scripts/build_sqlite.py`, not in
  git. Link to it as a download ("Download the data (SQLite)").

### Record (the normalized trial; Python `normalize()` in `scripts/fetch_trials.py` is the reference)

```
id                      "NCT07078461"
title                   string
status                  RECRUITING | NOT_YET_RECRUITING | ENROLLING_BY_INVITATION |
                        ACTIVE_NOT_RECRUITING | COMPLETED | TERMINATED | WITHDRAWN |
                        SUSPENDED | UNKNOWN | (expanded access statuses) | null
whyStopped              string | null
type                    INTERVENTIONAL | OBSERVATIONAL | EXPANDED_ACCESS | null
phases                  string[]  e.g. ["PHASE1","PHASE2"], ["NA"], []
sponsor                 string | null
sponsorClass            INDUSTRY | NIH | FED | OTHER_GOV | OTHER | NETWORK | INDIV | AMBIG | UNKNOWN | null
enrollment              number | null
start                   "YYYY-MM" | "YYYY-MM-DD" | null
primaryCompletion       same
primaryCompletionType   ACTUAL | ESTIMATED | null
completion              date string | null
firstPosted             date string | null
lastUpdate              date string | null
verified                "YYYY-MM" | null   (statusVerifiedDate)
conditions              string[]
interventions           [{type, name}]
hasResults              boolean
summary                 string (≤ 600 chars + "…")
sites                   [{lat, lon, city, country, status}]  (only sites with coordinates)
```

### Live search (any condition not prebuilt)

The API sends `access-control-allow-origin: *` on GET (verified 2026-10-25), so
the browser calls it directly. Use a plain `fetch(url)` with no custom headers
(custom headers trigger a preflight, which the API rejects with 403).

```
https://clinicaltrials.gov/api/v2/studies?query.cond=<q>&pageSize=1000&countTotal=true&fields=protocolSection,hasResults[&pageToken=…]
```

Response: `{totalCount, studies: [raw study], nextPageToken?}`. Follow
`nextPageToken` up to `MAX_LIVE_PAGES = 5` (5,000 trials). If capped, say
"Showing the first 5,000 of 12,345 trials ClinicalTrials.gov returned". Show
progress while loading. Raw studies go through `normalize.js`.

Raw fixtures for tests: `tests/fixtures/raw/<slug>.json` (real API pages,
`fields=protocolSection,hasResults`). This dev container cannot reach
clinicaltrials.gov; in browser tests, intercept the API with Playwright
`page.route` and serve these fixtures.

## Modules and owners

### Data layer (agent A)

`site/js/normalize.js`
- `export function normalize(rawStudy): Record`. Must equal Python
  `normalize()` field for field, including summary truncation (truncate to 600
  characters, cut back to the last space, append "…") and rounding lat/lon to
  2 decimals (match Python's `round`, which is round-half-even; document any
  edge case).

`site/js/analyze.js` (pure functions, no DOM; `today` is always passed in as a Date)
- `parseDate(s, {end=false})`: "YYYY", "YYYY-MM" or "YYYY-MM-DD" to a UTC Date; with `end`, the last day of that month/year. null for bad input.
- `phaseGroup(record)`: one of `"Early phase 1"`, `"Phase 1"`, `"Phase 1/2"`, `"Phase 2"`, `"Phase 2/3"`, `"Phase 3"`, `"Phase 4"`, `"Not phased"` (NA, empty, or observational). Export `PHASE_ORDER`.
- `statusGroup(status)`: `"Recruiting"` (RECRUITING, NOT_YET_RECRUITING, ENROLLING_BY_INVITATION), `"Active, not recruiting"`, `"Completed"`, `"Stopped early"` (TERMINATED, WITHDRAWN, SUSPENDED), `"Unknown"` (UNKNOWN, null, other). Export `STATUS_ORDER`.
- `sponsorGroup(cls)`: `"Industry"` (INDUSTRY), `"NIH & U.S. government"` (NIH, FED, OTHER_GOV), `"Universities, hospitals & other"` (everything else).
- `isQuiet(record, today, graceMonths=6)`: true when statusGroup is "Recruiting" and primary completion (end of its month) is more than `graceMonths` before `today`. Also export `quietListings(records, today)` sorted most overdue first, each `{record, monthsOverdue}`.
- `summarize(records, today)`: `{total, recruiting, active, completed, stopped, unknown, withResults, withResultsOfCompleted (share 0..1 of completed interventional trials with results), industryShare, quiet, firstYear, lastYear, medianEnrollment}`.
- `startsByYear(records)`: `[{year, phase, count}]` by start year and phase group (records with no start date are counted and returned separately as `undated`). Return `{rows, undated}`.
- `phaseByStatus(records)`: `[{phase, status, count}]` for interventional trials.
- `topSponsors(records, n=10)`: `{rows: [{sponsor, group, count}], others}`.
- `sponsorMix(records)`: `[{group, count, share}]`.
- `interventionTypes(records)`: `[{type, label, count}]` counting trials (not interventions) per type; labels in plain English ("Drug", "Device", "Behavioral", "Procedure or surgery", "Biological", "Dietary supplement", "Radiation", "Genetic", "Combination product", "Diagnostic test", "Other").
- `topInterventions(records, n=15)`: most-tested named interventions, counting trials; normalise names (case-fold, trim, collapse spaces, drop dosage like "1%" or "100 mg", map "placebo"/"vehicle" variants to one "Placebo or vehicle" bucket which is reported separately, not ranked). `{rows: [{name, count}], placeboTrials}`.
- `recruitingSites(records, today)`: sites of trials whose statusGroup is "Recruiting", excluding quiet listings, and whose site status is null or a recruiting status. `{points: [{lat, lon, city, country, trials}], countries: [{country, sites, trials}], trialCount}`; aggregate identical lat/lon.
- `searchRecords(records, {text, statusGroup, phase})`: filter for the trial table.

`site/js/data.js`
- `loadIndex()`, `loadPrebuilt(slug)` (fetch relative `data/…` paths).
- `findPrebuilt(index, query)`: slug match on label or slug, case-insensitive.
- `searchLive(query, {onProgress, maxPages=5, signal})`: returns `{label: query, records, totalCount, fetchedCount, capped, fetched: ISO string}`. Errors become a thrown `Error` with a plain-English message.
- `export const MAX_LIVE_PAGES = 5`.

Tests (owned by A):
- `tests/js/*.test.mjs` with `node:test` and `node:assert`, run by `node --test tests/js/`. Cover every export above, using raw fixtures and small hand-made records, including edge cases (missing dates, "YYYY" dates, multi-phase, empty arrays).
- `tests/test_contract.py`: for every study in every `tests/fixtures/raw/*.json`, Python `normalize()` and JS `normalize()` (run via `node` subprocess) produce identical JSON.
- Add a `node --test tests/js/` step to `.github/workflows/ci.yml` (use `actions/setup-node@v5`, node 22).

### Explorer UI (agent B)

Files: `site/index.html`, `site/css/style.css`, `site/js/charts.js`, `site/js/app.js`.

- Header: site name "Clinical Trials Explorer", one-line promise, the
  not-medical-advice notice, link to the story.
- Search: a labelled text input with a `<datalist>` of prebuilt conditions,
  a submit button, and chips for the prebuilt conditions. URL state `?q=…`
  (shareable, back button works). Default view with no query: rosacea.
- Prebuilt match loads `data/<slug>.json`; anything else goes live with a
  progress line ("Loading 2,000 of 4,812 trials…"). Errors show plainly with
  a retry.
- Sections, in this order, each with an `h2`, one sentence that states the
  finding with its number (computed), then the chart:
  1. **At a glance**: a generated headline sentence plus 5 stat tiles
     (Trials registered, Recruiting now, Completed, Completed trials with
     posted results %, Listings not updated). Note the data date.
  2. **When research happened**: stacked bars of trials started per year by
     phase group (stacking is valid; segments sum to all trials started).
     Note undated trials.
  3. **How far trials get**: horizontal stacked bars, one row per phase group
     (interventional only), segments by status group. Order rows by
     `PHASE_ORDER`.
  4. **Who pays for it**: top 10 lead sponsors as horizontal bars coloured by
     sponsor group, plus the sponsor mix as a single 100% bar or three tiles.
  5. **Where you could take part**: world map (Plot geo, equal-earth
     projection, countries from `countries-110m.json`) with dots for
     recruiting sites sized by trials, plus a top-countries list. If none,
     say so.
  6. **What gets tested**: intervention types bars and top named
     interventions bars; state how many trials use a placebo or vehicle.
  7. **Listings not updated**: a table of quiet listings (title link, status
     as listed, planned primary completion, months overdue, sponsor), with a
     neutral explanation of what it means.
  8. **All trials**: a filterable table (text filter, status group, phase)
     with title link to `https://clinicaltrials.gov/study/<id>`, status,
     phase, sponsor, start, enrollment; row expands to show the summary.
     Show 50 at a time with "Show more", and say "Showing 50 of 237".
  9. **What changed recently** (prebuilt only, from `changes.json`).
- Footer: data source with link, fetch date, downloads (condition JSON,
  SQLite), MIT license, notice again.
- `charts.js` exports one function per chart: `(data, {width}) => SVGElement
  or HTMLElement`, using Plot. One categorical palette for phase groups, one
  for status groups, one for sponsor groups, defined once as CSS-friendly
  constants and reused across charts. Colour-blind safe. Axis labels with units.
  Tooltips via Plot `tip`.

### Story page and deploy (agent C)

Files: `site/story.html`, `site/css/story.css` (page-specific additions only;
link `css/style.css` from B for the base design), `site/js/story.js`,
`site/data/story.json`, `.github/workflows/pages.yml`.

- The story reads top to bottom in short sections (each: headline sentence
  with the computed number, 1–3 short paragraphs, one chart):
  1. KP has a tiny fraction of the trials of other common skin conditions
     (bar chart of trials per condition across all six prebuilt conditions).
  2. Research over time per condition (small multiples, one line or bar
     panel per condition, shared x, independent or log y stated clearly).
  3. What gets tested for KP vs rosacea (intervention type comparison).
  4. New approaches in rosacea: cards from `site/data/story.json` (curated:
     NCT id + plain-English one-liner), each showing live status, phase and
     sponsor from the data, linking to the trial. If an id is missing from the
     data, the card says so instead of breaking.
  5. Listings not updated across the six conditions (share of "Recruiting"
     listings that are quiet, per condition).
  6. Close: invite readers to explore any condition (link to the explorer with `?q=`).
- `story.js` imports `analyze.js` and `data.js`. It may import from
  `charts.js` only if needed; prefer its own small chart functions.
- `story.json` curated cards to start with (verify each id exists in
  `site/data/rosacea.json` or `keratosis-pilaris.json` and write neutral,
  non-promotional one-liners): NCT07681271 (remibrutinib, oral BTK inhibitor,
  Novartis), NCT07600424 (ear vagus nerve stimulation for flushing),
  NCT06312813 (topical imipramine and amitriptyline for UV redness),
  NCT07341087 (probiotic drink, skin inflammation in menopause), NCT07078461
  (thulium laser for KP).
- `pages.yml`: on push to main, on `workflow_dispatch`, and on
  `workflow_run` of "Refresh trial data" (completed, success): checkout,
  setup-python, `python scripts/build_sqlite.py`,
  `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4` with
  `path: site`, `actions/deploy-pages@v4`. Permissions `pages: write`,
  `id-token: write`, `contents: read`. Concurrency group `pages`.

## Local preview and checks

```sh
python3 -m http.server -d site 8765    # then open http://localhost:8765/
node --test tests/js/
python3 -m pytest -q
```

Playwright is preinstalled (`require('playwright')` from any directory,
`chromium.launch()` with no options). Do not run `playwright install`.
