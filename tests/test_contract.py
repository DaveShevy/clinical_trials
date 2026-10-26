"""Contract: site/js/normalize.js and scripts/fetch_trials.py normalize() agree.

For every study in every tests/fixtures/raw/*.json, plus the synthetic page and
a set of generated edge cases (rounding ties, unicode summaries, Python
truthiness), both implementations must produce identical records: same keys in
the same order, same types, same values.

JSON cannot tell -0.0 from 0, and JavaScript writes 40.0 as 40, so the node side
tags negative zero explicitly and numbers compare by value (bit-exact for
floats, since both sides print round-trip representations). bool never equals
int here, unlike Python's True == 1.

Needs node (22+) on PATH. Outside CI a missing node skips; in CI it fails.
"""

import json
import math
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_trials  # noqa: E402

RAW = ROOT / "tests" / "fixtures" / "raw"
SYNTHETIC = ROOT / "tests" / "fixtures" / "synthetic_page.json"
NORMALIZE_JS = ROOT / "site" / "js" / "normalize.js"
NEG_ZERO = "__negative_zero__"

NODE_SCRIPT = """
import { normalize } from %s;
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const studies = JSON.parse(input);
const out = studies.map((s) => normalize(s));
process.stdout.write(JSON.stringify(out, (k, v) => (Object.is(v, -0) ? %s : v)));
""" % (json.dumps(NORMALIZE_JS.as_uri()), json.dumps(NEG_ZERO))

# Python's whitespace set; normalize.js must strip exactly these.
PY_WHITESPACE = "".join(chr(c) for c in range(sys.maxunicode + 1) if chr(c).isspace())


def fixture_cases():
    cases = []
    for path in sorted(RAW.glob("*.json")):
        for i, study in enumerate(json.loads(path.read_text())["studies"]):
            nct = study.get("protocolSection", {}).get("identificationModule", {}).get("nctId")
            cases.append((f"{path.stem}/{nct or i}", study))
    for i, study in enumerate(json.loads(SYNTHETIC.read_text())["studies"]):
        cases.append((f"synthetic/{i}", study))
    return cases


def summary_study(text):
    return {"protocolSection": {"descriptionModule": {"briefSummary": text}}}


def geo_study(points):
    return {"protocolSection": {"contactsLocationsModule": {"locations": [
        {"city": "C", "country": "X", "status": "RECRUITING", "geoPoint": g} for g in points
    ]}}}


def edge_cases():
    rng = random.Random(20261025)
    cases = []

    # Rounding: exact half-way doubles (k/8), classic traps, and many values
    # with 1-6 decimals like the API's.
    ties = [k / 8 for k in range(-1440, 1441, 1)]
    traps = [2.675, 1.005, 0.005, 0.995, 1.115, -1.115, 0.015, 0.025, 0.045, 12.345, -0.001,
             -0.004, -0.005, 0.0, -0.0, 1e-9, -1e-9, 179.995, -179.995, 89.999, 40, -73, 0]
    randoms = [round(rng.uniform(-180, 180), rng.randint(1, 6)) for _ in range(6000)]
    randoms += [rng.uniform(-180, 180) for _ in range(2000)]
    values = ties + traps + randoms
    for start in range(0, len(values), 500):
        chunk = values[start:start + 500]
        cases.append((f"round/{start}", geo_study([{"lat": a, "lon": b} for a, b in zip(chunk, reversed(chunk))])))
    cases.append(("geo/missing", geo_study([None, {}, {"lat": 1.0}, {"lon": 2.0}, {"lat": None, "lon": 1.0},
                                           {"lat": 0, "lon": 0}, {"lat": 0.0, "lon": -0.0}])))

    # Summaries: code points vs UTF-16, spaces at the cut, whitespace sets.
    emoji, combining = "\U0001F600", "é"
    summaries = {
        "short": "A short summary.",
        "exactly600": "x" * 600,
        "601": "x" * 601,
        "words": "word " * 400,
        "emoji700": emoji * 700,
        "emoji300": emoji * 300,
        "emoji-space-299": emoji * 300 + " " + "b" * 299,
        "emoji-space-300": emoji * 300 + " " + "b" * 300,
        "emoji-at-600": "a" * 599 + emoji + "zzz",
        "emoji-straddle": ("ab " + emoji) * 200,
        "space-at-600": "a" * 599 + " " + "b" * 10,
        "space-at-601": "a" * 600 + " " + "b" * 10,
        "trailing-spaces-at-cut": "a" * 590 + " " * 20 + "b" * 10,
        "combining": (combining + " ") * 250,
        "cjk": "皮肤病" * 250,
        "nbsp-not-a-split": ("word " * 150) + " tail",
        "py-whitespace-edges": PY_WHITESPACE + "core text" + PY_WHITESPACE,
        "bom-kept": "﻿core﻿",
        "zwsp-kept": "​core​",
        "whitespace-only": PY_WHITESPACE,
        "lone-surrogates": "\ud800" * 601,
        "newlines": ("line one\n\nline two " * 60),
        "empty": "",
        "none": None,
    }
    for name, text in summaries.items():
        cases.append((f"summary/{name}", summary_study(text)))

    # Python truthiness and missing pieces.
    cases += [
        ("empty-study", {}),
        ("empty-protocol", {"protocolSection": {}}),
        ("empty-modules", {"protocolSection": {k: {} for k in (
            "identificationModule", "statusModule", "designModule", "sponsorCollaboratorsModule",
            "descriptionModule", "conditionsModule", "armsInterventionsModule", "contactsLocationsModule")}}),
        ("title-fallback", {"protocolSection": {"identificationModule": {"briefTitle": "", "officialTitle": "Off"}}}),
        ("title-none", {"protocolSection": {"identificationModule": {"briefTitle": None, "officialTitle": ""}}}),
        ("phases-null", {"protocolSection": {"designModule": {"phases": None, "enrollmentInfo": None}}}),
        ("enrollment-zero", {"protocolSection": {"designModule": {"enrollmentInfo": {"count": 0}}}}),
        ("enrollment-empty", {"protocolSection": {"designModule": {"enrollmentInfo": {}}}}),
        ("dates", {"protocolSection": {"statusModule": {
            "startDateStruct": {"date": "2009"}, "primaryCompletionDateStruct": {},
            "completionDateStruct": None, "studyFirstPostDateStruct": {"date": "2009-01-02"},
            "statusVerifiedDate": "2012-02", "whyStopped": "Funding"}}}),
        ("pc-type-only", {"protocolSection": {"statusModule": {"primaryCompletionDateStruct": {"type": "ACTUAL"}}}}),
        ("lists-null", {"protocolSection": {"conditionsModule": {"conditions": None},
                                            "armsInterventionsModule": {"interventions": None}}}),
        ("interventions-partial", {"protocolSection": {"armsInterventionsModule": {"interventions": [
            {}, {"type": "DRUG"}, {"name": "Only a name"}, {"type": "OTHER", "name": "N", "extra": 1}]}}}),
        ("sponsor-partial", {"protocolSection": {"sponsorCollaboratorsModule": {"leadSponsor": {"name": "S"}}}}),
    ]
    for value in (True, False, 0, 1, "false", "", [], {}, [0], None):
        cases.append((f"hasResults/{json.dumps(value)}", {"hasResults": value}))
    return cases


CASES = fixture_cases() + edge_cases()


def canonical(value):
    """Python-side record in the form the node side reports."""
    if isinstance(value, float) and value == 0 and math.copysign(1, value) < 0:
        return NEG_ZERO
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value


def differences(py, js, path="$"):
    """List every place where two decoded records differ, strictly."""
    if isinstance(py, bool) or isinstance(js, bool):
        return [] if type(py) is type(js) and py == js else [f"{path}: python {py!r} != js {js!r}"]
    if isinstance(py, (int, float)) and isinstance(js, (int, float)):
        return [] if py == js else [f"{path}: python {py!r} != js {js!r}"]
    if type(py) is not type(js):
        return [f"{path}: python {type(py).__name__} {py!r} != js {type(js).__name__} {js!r}"]
    if isinstance(py, dict):
        if list(py) != list(js):
            return [f"{path}: keys python {list(py)} != js {list(js)}"]
        return [d for k in py for d in differences(py[k], js[k], f"{path}.{k}")]
    if isinstance(py, list):
        if len(py) != len(js):
            return [f"{path}: length python {len(py)} != js {len(js)}"]
        return [d for i, (a, b) in enumerate(zip(py, js)) for d in differences(a, b, f"{path}[{i}]")]
    return [] if py == js else [f"{path}: python {py!r} != js {js!r}"]


@pytest.fixture(scope="module")
def js_records():
    node = shutil.which("node")
    if not node:
        if os.environ.get("CI"):
            pytest.fail("node is required for the normalize contract test")
        pytest.skip("node is not installed")
    payload = json.dumps([study for _, study in CASES])  # ASCII-only: lone surrogates survive
    proc = subprocess.run(
        [node, "--input-type=module", "-e", NODE_SCRIPT],
        input=payload.encode("ascii"), capture_output=True, timeout=120, check=False,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    out = json.loads(proc.stdout.decode("utf-8"))
    assert len(out) == len(CASES)
    return dict(zip((name for name, _ in CASES), out))


def test_cases_cover_every_raw_fixture():
    files = sorted(RAW.glob("*.json"))
    assert len(files) >= 6
    total = sum(len(json.loads(p.read_text())["studies"]) for p in files)
    assert sum(1 for name, _ in CASES if name.split("/")[0] in {p.stem for p in files}) == total
    assert len({name for name, _ in CASES}) == len(CASES)


@pytest.mark.parametrize("name,study", CASES, ids=[name for name, _ in CASES])
def test_js_normalize_matches_python(js_records, name, study):
    expected = canonical(fetch_trials.normalize(study))
    diffs = differences(expected, js_records[name])
    assert not diffs, "\n".join(diffs[:20])


def test_comparison_is_strict():
    """The comparator itself must catch the differences that matter."""
    assert differences({"a": True}, {"a": 1})
    assert differences({"a": 1, "b": 2}, {"b": 2, "a": 1})
    assert differences([0.12], [0.13])
    assert differences(canonical(-0.0), 0)
    assert not differences({"a": 40.0}, {"a": 40})
    assert differences({"a": None}, {"a": ""})
