"""Rebuild the Yardage Book page and the CSV exports from courses/*.json.

Usage (from the repo root): python3 docs/research/course-data/tools/build.py
"""
import csv
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORDER = ["chambers-bay", "st-andrews-old", "pebble-beach", "bandon-dunes", "tpc-sawgrass", "whistling-straits"]

data = [json.load(open(os.path.join(BASE, "courses", f"{s}.json"))) for s in ORDER]
blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
tpl = open(os.path.join(BASE, "tools", "yardage-book.template.html")).read()
assert tpl.count("/*__DATA__*/") == 1
with open(os.path.join(BASE, "yardage-book.html"), "w") as f:
    f.write(tpl.replace("/*__DATA__*/", blob))

out = os.path.join(BASE, "csv")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "holes.csv"), "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["course", "hole", "name", "par", "handicap", "elevation_change_ft", "elevation_direction",
                "elevation_confidence", "ob_present", "ob_sides", "ob_confidence", "penalty_areas",
                "green_size_sqft", "green_depth_yards", "green_width_yards", "green_slope", "green_features", "notes"])
    for c in data:
        for h in sorted(c["holes"], key=lambda h: h["number"]):
            e = h.get("elevation") or {}
            o = h.get("out_of_bounds") or {}
            g = h.get("green") or {}
            w.writerow([c["slug"], h["number"], h.get("name"), h.get("par"), h.get("handicap"), e.get("change_ft"),
                        e.get("direction"), e.get("confidence"), o.get("present"), "|".join(o.get("sides") or []),
                        o.get("confidence"), (h.get("penalty_areas") or {}).get("description"), g.get("size_sqft"),
                        g.get("depth_yards"), g.get("width_yards"), g.get("slope"), g.get("features"), h.get("notes")])
with open(os.path.join(out, "yardages.csv"), "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["course", "hole", "tee", "yards"])
    for c in data:
        for h in sorted(c["holes"], key=lambda h: h["number"]):
            for tee, y in (h.get("yards") or {}).items():
                w.writerow([c["slug"], h["number"], tee, y])
with open(os.path.join(out, "tees.csv"), "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["course", "tee", "sex", "total_yards", "par", "rating", "slope"])
    for c in data:
        for t in c["tees"]:
            w.writerow([c["slug"], t["name"], t.get("sex"), t.get("total_yards"), t.get("par"), t.get("rating"), t.get("slope")])
print("built yardage-book.html and csv/")
