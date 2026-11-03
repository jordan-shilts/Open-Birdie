"""Validate course JSON files against SCHEMA.md and report coverage.

Usage (from the repo root): python3 docs/research/course-data/tools/check.py docs/research/course-data/courses/*.json
"""
import json
import sys
from collections import Counter


def check(path):
    problems, notes = [], []
    with open(path) as f:
        d = json.load(f)
    name = d.get("course", path)
    src_ids = {s.get("id") for s in d.get("sources", [])}
    holes = d.get("holes", [])
    nums = [h.get("number") for h in holes]
    if sorted(nums) != list(range(1, 19)):
        problems.append(f"hole numbers are {nums}")

    def ref(obj, where):
        if not isinstance(obj, dict):
            return
        s = obj.get("source")
        if s and s not in src_ids:
            # allow lists like "S1, S2"
            parts = [p.strip() for p in str(s).replace(";", ",").split(",")]
            missing = [p for p in parts if p and p not in src_ids]
            if missing:
                problems.append(f"{where}: unknown source {missing}")

    for key in ("greens", "boundaries"):
        ref(d.get(key), key)

    tees = d.get("tees", [])
    for t in tees:
        ref(t, f"tee {t.get('name')}")
        tname, total = t.get("name"), t.get("total_yards")
        ys = [h.get("yards", {}).get(tname) for h in holes]
        if total and all(isinstance(y, (int, float)) for y in ys):
            s = sum(ys)
            if s != total:
                problems.append(f"tee {tname}: holes sum to {s}, scorecard total {total}")
            else:
                notes.append(f"tee {tname}: {s} yd matches")
        elif total:
            missing = sum(1 for y in ys if not isinstance(y, (int, float)))
            notes.append(f"tee {tname}: {missing} holes lack a yardage")
        par_total = t.get("par")
        pars = [h.get("par") for h in holes]
        if par_total and all(isinstance(p, int) for p in pars) and sum(pars) != par_total:
            problems.append(f"tee {tname}: hole pars sum to {sum(pars)}, tee par {par_total}")

    hcp = [h.get("handicap") for h in holes if h.get("handicap") is not None]
    if hcp and sorted(hcp) != list(range(1, 19)):
        problems.append(f"handicaps not a 1-18 permutation: {sorted(hcp)}")

    cov = Counter()
    for h in holes:
        n = h.get("number")
        for sec in ("elevation", "out_of_bounds", "penalty_areas", "green"):
            ref(h.get(sec), f"hole {n} {sec}")
        if h.get("par"):
            cov["par"] += 1
        if any(isinstance(v, (int, float)) for v in (h.get("yards") or {}).values()):
            cov["yards"] += 1
        el = h.get("elevation") or {}
        if isinstance(el.get("change_ft"), (int, float)):
            cov["elevation_ft"] += 1
        if el.get("direction") or el.get("description"):
            cov["elevation_any"] += 1
        ob = h.get("out_of_bounds") or {}
        if ob.get("present") is not None:
            cov["ob_known"] += 1
        if ob.get("present"):
            cov["ob_present"] += 1
        if (h.get("penalty_areas") or {}).get("description"):
            cov["penalty_areas"] += 1
        g = h.get("green") or {}
        if isinstance(g.get("size_sqft"), (int, float)):
            cov["green_sqft"] += 1
        if isinstance(g.get("depth_yards"), (int, float)):
            cov["green_depth"] += 1
        if g.get("slope") or g.get("features"):
            cov["green_shape"] += 1

    print(f"\n== {name} ({path.split('/')[-1]})")
    print("  tees:", ", ".join(f"{t.get('name')} {t.get('total_yards')}" for t in tees))
    print("  coverage /18:", dict(cov))
    for n in notes:
        print("  ok:", n)
    for p in problems:
        print("  PROBLEM:", p)
    print("  gaps:", len(d.get("gaps", [])), "| sources:", len(src_ids))
    return not problems


if __name__ == "__main__":
    ok = all([check(p) for p in sys.argv[1:]])
    sys.exit(0 if ok else 1)
