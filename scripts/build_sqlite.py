"""Build a downloadable SQLite database from site/data/*.json and the status history.

Usage: python scripts/build_sqlite.py [--out site/data/trials.sqlite3]
"""

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCHEMA = """
CREATE TABLE trials (
    nct_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT,
    why_stopped TEXT,
    study_type TEXT,
    phases TEXT,
    sponsor TEXT,
    sponsor_class TEXT,
    enrollment INTEGER,
    start_date TEXT,
    primary_completion_date TEXT,
    completion_date TEXT,
    first_posted TEXT,
    last_update TEXT,
    has_results INTEGER,
    summary TEXT
);
CREATE TABLE trial_conditions (
    nct_id TEXT NOT NULL REFERENCES trials(nct_id),
    condition_slug TEXT NOT NULL,
    PRIMARY KEY (nct_id, condition_slug)
);
CREATE TABLE conditions_listed (
    nct_id TEXT NOT NULL REFERENCES trials(nct_id),
    condition TEXT NOT NULL
);
CREATE TABLE interventions (
    nct_id TEXT NOT NULL REFERENCES trials(nct_id),
    type TEXT,
    name TEXT
);
CREATE TABLE sites (
    nct_id TEXT NOT NULL REFERENCES trials(nct_id),
    lat REAL,
    lon REAL,
    city TEXT,
    country TEXT,
    status TEXT
);
CREATE TABLE status_history (
    nct_id TEXT NOT NULL,
    status TEXT,
    seen_at TEXT NOT NULL
);
"""


def build(data_dir, history_path, out_path):
    out_path.unlink(missing_ok=True)
    conn = sqlite3.connect(out_path)
    conn.executescript(SCHEMA)
    index = json.loads((data_dir / "index.json").read_text())
    seen = set()
    for cond in index["conditions"]:
        doc = json.loads((data_dir / f"{cond['slug']}.json").read_text())
        for t in doc["trials"]:
            conn.execute("INSERT OR IGNORE INTO trial_conditions VALUES (?, ?)", (t["id"], cond["slug"]))
            if t["id"] in seen:
                continue
            seen.add(t["id"])
            conn.execute(
                "INSERT INTO trials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (t["id"], t["title"], t["status"], t["whyStopped"], t["type"], json.dumps(t["phases"]),
                 t["sponsor"], t["sponsorClass"], t["enrollment"], t["start"], t["primaryCompletion"],
                 t["completion"], t["firstPosted"], t["lastUpdate"], int(t["hasResults"]), t["summary"]),
            )
            conn.executemany("INSERT INTO conditions_listed VALUES (?, ?)", [(t["id"], c) for c in t["conditions"]])
            conn.executemany("INSERT INTO interventions VALUES (?, ?, ?)",
                             [(t["id"], i["type"], i["name"]) for i in t["interventions"]])
            conn.executemany("INSERT INTO sites VALUES (?, ?, ?, ?, ?, ?)",
                             [(t["id"], s["lat"], s["lon"], s["city"], s["country"], s["status"]) for s in t["sites"]])
    if history_path.exists():
        with history_path.open(newline="") as fh:
            conn.executemany("INSERT INTO status_history VALUES (:nct_id, :status, :seen_at)", csv.DictReader(fh))
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    return len(seen)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(ROOT / "site" / "data"))
    parser.add_argument("--history", default=str(ROOT / "data" / "status_history.csv"))
    parser.add_argument("--out", default=str(ROOT / "site" / "data" / "trials.sqlite3"))
    args = parser.parse_args(argv)
    n = build(Path(args.data), Path(args.history), Path(args.out))
    print(f"wrote {args.out}: {n} trials")
    return 0


if __name__ == "__main__":
    sys.exit(main())
