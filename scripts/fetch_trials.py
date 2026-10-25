"""Fetch trials for each condition in conditions.json from ClinicalTrials.gov API v2.

Writes one normalized JSON file per condition to site/data/, appends status
changes to data/status_history.csv, and writes site/data/changes.json.

Usage:
    python scripts/fetch_trials.py
    python scripts/fetch_trials.py --only rosacea
    python scripts/fetch_trials.py --capture-fixtures tests/fixtures/raw
"""

import argparse
import csv
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://clinicaltrials.gov/api/v2/studies"
FIELDS = "protocolSection,hasResults"
PAGE_SIZE = 1000
SUMMARY_CHARS = 600
HISTORY_FIELDS = ["nct_id", "status", "seen_at"]


def get_json(params, retries=4):
    url = f"{API}?{urllib.parse.urlencode(params)}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "clinical-trials-explorer"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as err:
            if err.code < 500 and err.code != 429:
                raise
            last = err
        except urllib.error.URLError as err:
            last = err
        time.sleep(2 ** (attempt + 1))
    raise last


def fetch_studies(query, page_size=PAGE_SIZE, max_pages=None):
    """Yield raw study objects for a condition query, following page tokens."""
    params = {"query.cond": query, "pageSize": page_size, "fields": FIELDS, "countTotal": "true"}
    pages = 0
    while True:
        payload = get_json(params)
        yield from payload.get("studies", [])
        pages += 1
        token = payload.get("nextPageToken")
        if not token or (max_pages and pages >= max_pages):
            return
        params["pageToken"] = token


def _date(struct):
    return (struct or {}).get("date")


def normalize(study):
    """Reduce a raw API v2 study to the record the site uses.

    site/js/normalize.js implements the same mapping for live searches;
    tests/test_contract.py checks that both agree.
    """
    p = study.get("protocolSection", {})
    ident = p.get("identificationModule", {})
    status = p.get("statusModule", {})
    design = p.get("designModule", {})
    lead = p.get("sponsorCollaboratorsModule", {}).get("leadSponsor", {})
    summary = (p.get("descriptionModule", {}).get("briefSummary") or "").strip()
    if len(summary) > SUMMARY_CHARS:
        summary = summary[:SUMMARY_CHARS].rsplit(" ", 1)[0] + "…"
    sites = []
    for loc in p.get("contactsLocationsModule", {}).get("locations", []):
        geo = loc.get("geoPoint")
        if not geo or geo.get("lat") is None or geo.get("lon") is None:
            continue
        sites.append({
            "lat": round(geo["lat"], 2),
            "lon": round(geo["lon"], 2),
            "city": loc.get("city"),
            "country": loc.get("country"),
            "status": loc.get("status"),
        })
    return {
        "id": ident.get("nctId"),
        "title": ident.get("briefTitle") or ident.get("officialTitle") or "",
        "status": status.get("overallStatus"),
        "whyStopped": status.get("whyStopped"),
        "type": design.get("studyType"),
        "phases": design.get("phases") or [],
        "sponsor": lead.get("name"),
        "sponsorClass": lead.get("class"),
        "enrollment": (design.get("enrollmentInfo") or {}).get("count"),
        "start": _date(status.get("startDateStruct")),
        "primaryCompletion": _date(status.get("primaryCompletionDateStruct")),
        "primaryCompletionType": (status.get("primaryCompletionDateStruct") or {}).get("type"),
        "completion": _date(status.get("completionDateStruct")),
        "firstPosted": _date(status.get("studyFirstPostDateStruct")),
        "lastUpdate": _date(status.get("lastUpdatePostDateStruct")),
        "verified": status.get("statusVerifiedDate"),
        "conditions": p.get("conditionsModule", {}).get("conditions") or [],
        "interventions": [
            {"type": i.get("type"), "name": i.get("name")}
            for i in p.get("armsInterventionsModule", {}).get("interventions") or []
        ],
        "hasResults": bool(study.get("hasResults")),
        "summary": summary,
        "sites": sites,
    }


def load_history(path):
    """Latest known status per trial from the append-only history CSV."""
    latest = {}
    if path.exists():
        with path.open(newline="") as fh:
            for row in csv.DictReader(fh):
                latest[row["nct_id"]] = row["status"]
    return latest


def record_changes(records_by_slug, history_path, changes_path, seen_at, labels):
    """Append status changes to the history CSV and rebuild the recent-changes feed."""
    latest = load_history(history_path)
    baseline = not latest
    new_rows, events = [], []
    seen = set()
    for slug, records in records_by_slug.items():
        for rec in records:
            nct = rec["id"]
            if nct in seen:
                continue
            seen.add(nct)
            before = latest.get(nct)
            if before == rec["status"]:
                continue
            new_rows.append({"nct_id": nct, "status": rec["status"], "seen_at": seen_at})
            if not baseline:
                events.append({
                    "date": seen_at[:10],
                    "id": nct,
                    "title": rec["title"],
                    "condition": labels[slug],
                    "from": before,
                    "to": rec["status"],
                })
    history_path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not history_path.exists()
    with history_path.open("a", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=HISTORY_FIELDS)
        if write_header:
            writer.writeheader()
        writer.writerows(new_rows)

    previous = []
    if changes_path.exists():
        previous = json.loads(changes_path.read_text()).get("events", [])
    feed = {"updated": seen_at, "baseline": baseline and not previous, "events": (events + previous)[:500]}
    changes_path.write_text(json.dumps(feed, ensure_ascii=False, indent=1) + "\n")
    return len(new_rows), len(events)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--conditions", default=str(ROOT / "conditions.json"))
    parser.add_argument("--out", default=str(ROOT / "site" / "data"))
    parser.add_argument("--history", default=str(ROOT / "data" / "status_history.csv"))
    parser.add_argument("--only", help="fetch one condition slug")
    parser.add_argument("--capture-fixtures", metavar="DIR",
                        help="save one raw API page per condition for tests, then exit")
    args = parser.parse_args(argv)

    conditions = json.loads(Path(args.conditions).read_text())
    if args.only:
        conditions = [c for c in conditions if c["slug"] == args.only]

    if args.capture_fixtures:
        out = Path(args.capture_fixtures)
        out.mkdir(parents=True, exist_ok=True)
        for cond in conditions:
            payload = get_json({"query.cond": cond["query"], "pageSize": 20,
                                "fields": FIELDS, "countTotal": "true"})
            (out / f"{cond['slug']}.json").write_text(json.dumps(payload, indent=1) + "\n")
            print(f"captured {cond['slug']}: {len(payload.get('studies', []))} studies")
        return 0

    seen_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    records_by_slug, index = {}, []
    for cond in conditions:
        records = [normalize(s) for s in fetch_studies(cond["query"])]
        records = [r for r in records if r["id"]]
        records.sort(key=lambda r: r["id"])
        records_by_slug[cond["slug"]] = records
        doc = {"slug": cond["slug"], "label": cond["label"], "query": cond["query"],
               "fetched": seen_at, "count": len(records), "trials": records}
        (out / f"{cond['slug']}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
        index.append({k: cond[k] for k in ("slug", "label", "group")} | {"count": len(records)})
        print(f"{cond['slug']}: {len(records)} trials")

    if not args.only:
        (out / "index.json").write_text(json.dumps({"fetched": seen_at, "conditions": index}, indent=1) + "\n")
    labels = {c["slug"]: c["label"] for c in conditions}
    added, events = record_changes(records_by_slug, Path(args.history), out / "changes.json", seen_at, labels)
    print(f"history: {added} rows added, {events} change events")
    return 0


if __name__ == "__main__":
    sys.exit(main())
