# Clinical Trials Explorer

See the research landscape for any condition at a glance. Type a condition and
get one page: how many trials there are, when they ran, how far they got, who
pays for them, where trials are recruiting, what kinds of intervention they
test, and which listings have not been updated.

The site has two pages, both static and built in the browser from the data:

- **Explorer** (`site/index.html`): search any condition. Prebuilt conditions
  load from `site/data/`; anything else is fetched live from the
  ClinicalTrials.gov API. Share a view with `index.html?q=rosacea`.
- **Story** (`site/story.html`): "The skin conditions research forgot", a
  short data story comparing keratosis pilaris with five other skin
  conditions. Its only hand-written data is `site/data/story.json`.

The data comes from [ClinicalTrials.gov](https://clinicaltrials.gov/), the U.S.
National Library of Medicine's public registry. Its own site is good at finding
one trial in a list; this project shows the whole picture.

**Not medical advice.** This project shows what researchers are studying. It
does not recommend any treatment or say whether a trial is right for you. Talk
to your doctor before joining or acting on any trial. A trial still listed as
"recruiting" after its end date usually means the record was not updated, not
that anything went wrong.

## How it works

1. `conditions.json` lists the conditions with prebuilt pages. The first
   showcase is dermatology: keratosis pilaris, rosacea, acne, eczema, psoriasis
   and hidradenitis suppurativa.
2. `scripts/fetch_trials.py` pulls those trials from the ClinicalTrials.gov
   API v2 into `site/data/`, and logs status changes in
   `data/status_history.csv`.
3. A weekly GitHub Action (`.github/workflows/refresh.yml`) reruns it and
   commits the new data.
4. `scripts/build_sqlite.py` packs everything into a SQLite file you can
   download and query yourself.

## Run locally

Python 3.10 or newer, no runtime dependencies.

```sh
python scripts/fetch_trials.py --only rosacea
python scripts/build_sqlite.py
sqlite3 site/data/trials.sqlite3 "SELECT status, COUNT(*) FROM trials GROUP BY status;"
```

Preview the site (no build step; the libraries are vendored in
`site/vendor/`):

```sh
python3 -m http.server -d site 8765    # then open http://localhost:8765/
```

Tests (Node 22 for the JavaScript, Python for the rest and the
JS/Python `normalize()` contract):

```sh
pip install -r requirements-dev.txt
node --test tests/js/
python -m pytest -q
```

The deploy workflow runs both before it publishes.

## License

Code: MIT. Trial data comes from ClinicalTrials.gov and is in the public
domain; see their [terms](https://clinicaltrials.gov/about-site/terms-conditions).
