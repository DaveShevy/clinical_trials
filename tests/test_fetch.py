import csv
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_sqlite  # noqa: E402
import fetch_trials  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


def synthetic_studies():
    return json.loads((FIXTURES / "synthetic_page.json").read_text())["studies"]


def test_normalize_maps_fields():
    rec = fetch_trials.normalize(synthetic_studies()[0])
    assert rec["id"] == "NCT07078461"
    assert rec["status"] == "RECRUITING"
    assert rec["phases"] == ["NA"]
    assert rec["sponsorClass"] == "OTHER"
    assert rec["enrollment"] == 25
    assert rec["primaryCompletion"] == "2026-12"
    assert rec["primaryCompletionType"] == "ESTIMATED"
    assert rec["interventions"] == [{"type": "DEVICE", "name": "1927-nm Thulium Laser therapy"}]
    # Locations without coordinates are dropped; coordinates are rounded.
    assert rec["sites"] == [{"lat": 39.29, "lon": -76.61, "city": "Baltimore",
                             "country": "United States", "status": "RECRUITING"}]


def test_normalize_handles_missing_modules():
    rec = fetch_trials.normalize(synthetic_studies()[1])
    assert rec["whyStopped"] == "Low enrollment"
    assert rec["completion"] is None
    assert rec["sites"] == []
    assert rec["hasResults"] is True
    assert fetch_trials.normalize({})["phases"] == []


def test_summary_is_truncated_on_a_word():
    study = {"protocolSection": {"descriptionModule": {"briefSummary": "word " * 400}}}
    summary = fetch_trials.normalize(study)["summary"]
    assert len(summary) <= fetch_trials.SUMMARY_CHARS + 1
    assert summary.endswith("word…")


def run_main(tmp_path, monkeypatch, studies):
    conditions = tmp_path / "conditions.json"
    conditions.write_text(json.dumps([{"slug": "kp", "label": "KP", "query": "kp", "group": "Dermatology"}]))
    monkeypatch.setattr(fetch_trials, "fetch_studies", lambda query: iter(studies))
    fetch_trials.main(["--conditions", str(conditions), "--out", str(tmp_path / "site"),
                       "--history", str(tmp_path / "history.csv")])


def test_first_run_is_a_baseline_then_changes_are_logged(tmp_path, monkeypatch):
    studies = synthetic_studies()
    run_main(tmp_path, monkeypatch, studies)
    feed = json.loads((tmp_path / "site" / "changes.json").read_text())
    assert feed["baseline"] is True and feed["events"] == []
    doc = json.loads((tmp_path / "site" / "kp.json").read_text())
    assert doc["count"] == 2 and [t["id"] for t in doc["trials"]] == ["NCT00944216", "NCT07078461"]

    studies[0]["protocolSection"]["statusModule"]["overallStatus"] = "COMPLETED"
    run_main(tmp_path, monkeypatch, studies)
    feed = json.loads((tmp_path / "site" / "changes.json").read_text())
    assert feed["baseline"] is False
    assert [(e["id"], e["from"], e["to"]) for e in feed["events"]] == [("NCT07078461", "RECRUITING", "COMPLETED")]
    with (tmp_path / "history.csv").open() as fh:
        assert len(list(csv.DictReader(fh))) == 3


def test_build_sqlite(tmp_path, monkeypatch):
    run_main(tmp_path, monkeypatch, synthetic_studies())
    out = tmp_path / "trials.sqlite3"
    assert build_sqlite.build(tmp_path / "site", tmp_path / "history.csv", out) == 2
    conn = sqlite3.connect(out)
    assert conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0] == 1
    assert conn.execute("SELECT condition_slug FROM trial_conditions WHERE nct_id='NCT07078461'").fetchone()[0] == "kp"
    assert conn.execute("SELECT COUNT(*) FROM status_history").fetchone()[0] == 2
