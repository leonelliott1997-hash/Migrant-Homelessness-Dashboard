"""
Sanity checks run after every update, before anything is published.
If a source file changes layout and the pipeline misreads it, these fail the
GitHub Actions run (which emails the repository owner) and the site keeps the
last good data.
"""
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "docs" / "data" / "data.json"
ENGLAND = "E92000001"
REGIONS = [f"E1200000{i}" for i in range(1, 10)]

problems = []


def check(cond, msg):
    if not cond:
        problems.append(msg)


d = json.loads(DATA.read_text(encoding="utf-8"))
H = d["homelessness"]
Q = H["quarters"]
latest = Q[-1]
i = len(Q) - 1

las = [c for c, a in d["areas"].items() if a["type"] == "la" and a.get("current")]
check(len(las) >= 250, f"only {len(las)} current local authorities found")
check(all(d["areas"][c].get("region") for c in las), "some local authorities have no region")

for key in ("prevention", "relief", "prevention_all", "relief_all", "total", "total_all"):
    check(ENGLAND in H[key], f"England missing from homelessness.{key}")
    if ENGLAND in H[key]:
        check(H[key][ENGLAND][i] is not None, f"England {key} missing for {latest}")
        for r in REGIONS:
            check(H[key].get(r, [None])[-1] is not None, f"region {r} {key} missing for {latest}")

if ENGLAND in H["prevention"] and ENGLAND in H["prevention_all"]:
    p, pa = H["prevention"][ENGLAND][i], H["prevention_all"][ENGLAND][i]
    check(p is not None and pa is not None and 0 < p < pa, f"England prevention {p} not below all-reason total {pa}")
    # Regions should roughly add up to England (both rounded to nearest 10)
    reg_sum = sum(H["prevention"].get(r, [0])[i] or 0 for r in REGIONS)
    check(abs(reg_sum - p) <= 100, f"regions sum to {reg_sum} but England is {p}")
    # LA sum should be close to England (LA figures are unrounded)
    la_sum = sum((H["prevention"].get(c, [None] * len(Q))[i] or 0) for c in las)
    check(abs(la_sum - p) <= max(100, 0.1 * p), f"local authorities sum to {la_sum} but England is {p}")

R = d["rough_sleeping"]
check(len(R["months"]) >= 12, "fewer than 12 months of rough sleeping data")
check(R["asylum"].get(ENGLAND, [None])[-1] is not None, "latest England rough sleeping value missing")

S = d["asylum_support"]
check(S["people"].get(ENGLAND, [0])[-1] > 10000, "England asylum support total looks too low")

G = d["grants"]
check(G["grants"][-1] > 0, "latest grants of protection is zero")

if problems:
    print("DATA CHECKS FAILED:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print(f"Data checks passed: {len(las)} local authorities, latest quarter {latest}, "
      f"rough sleeping to {R['months'][-1]}, asylum support to {S['quarters'][-1]}.")
