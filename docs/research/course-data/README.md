# Course reference data

Researched hole-by-hole data for the seven courses Open-Birdie features (`courses/featured.json`): Chambers Bay, the Old Course at St Andrews, Pebble Beach Golf Links, Bandon Dunes, the TPC Sawgrass Stadium Course, the Straits Course at Whistling Straits and Hazeltine National Golf Club. Gathered November 2026 from official scorecards, course and resort sites, USGA, R&A and PGA TOUR material, and golf publications.

Every fact names its source, and a field nobody publishes is `null`, never an estimate. Use it for scorecards, tee selection, par and handicap, hazard and OB placement, and as ground truth when checking what the sim derives from OpenStreetMap and elevation data.

## What's here

| Path | What it is |
|---|---|
| `courses/<slug>.json` | One file per course: tees (yards, par, rating, slope), course-wide greens, OB and penalty-area summaries, 18 holes, sources, and a `gaps` list of what could not be found or conflicts between sources. |
| `SCHEMA.md` | Field definitions and the rules the research followed. |
| `csv/holes.csv` | One row per hole: par, handicap, elevation, OB, penalty areas, green size/depth/slope, notes. |
| `csv/yardages.csv` | One row per hole per tee. |
| `csv/tees.csv` | One row per tee set: totals, rating and slope. |
| `yardage-book.html` | Self-contained viewer with a tab per course and expandable holes. Open it in a browser (it loads two Google Fonts). |
| `tools/check.py` | Validates the JSON and reports coverage; checks that every tee's hole yardages add up to its published total. |
| `tools/build.py` | Rebuilds `yardage-book.html` and `csv/` from `courses/*.json`. |

Slugs: `chambers-bay`, `st-andrews-old`, `pebble-beach`, `bandon-dunes`, `tpc-sawgrass`, `whistling-straits`, `hazeltine-national`. The folder also holds `augusta-national.json` and `augusta-national-par-3.json`, which the viewer and CSVs don't include.

## Coverage

Holes out of 18 with each figure:

| Course | Tees with yardages | Elevation in feet | OB documented | Green size | Green depth |
|---|---|---|---|---|---|
| Chambers Bay | 9 (Oct 2025 card) | 3 | 1 | 1 | 2 |
| St Andrews Old | 3, plus Open setups | 0 | 18 (OB on 6 holes) | 6 | 3 |
| Pebble Beach | 8, plus 3 tournament setups | 1 | 3 | 3 | 1 |
| Bandon Dunes | 6 | 0 | 0 | 0 | 1 |
| TPC Sawgrass | 6, plus 2026 PLAYERS | 0 | 1 | 1 | 18 |
| Whistling Straits | 5 | 0 | 0 | 0 | 0 |
| Hazeltine National | 9, plus 4 tournament setups | 1 | 2 | 0 | 0 |

Par, handicap and per-tee yardages are complete for all 126 holes, and every tee's holes sum to its published total. Elevation in feet, OB and green sizes are rarely published, which is why the next section matters.

## Things that affect the sim

- **Chambers Bay greens are Poa annua** (re-sodded 2017–19), not the original fine fescue. No. 13 is a par 5 on the current card (a par-4 at the 2015 U.S. Open), and No. 1 is a par 4.
- **Pebble Beach No. 2** is a par 5 for resort play but a par 4 at the U.S. Open, so the 2019 U.S. Open tee entry totals par 71. Hole pars in the file are resort pars.
- **St Andrews:** the tee entries with par 76 are women's ratings; hole pars are men's. No. 18 is printed longer from Blue (366) than Black (354) on the source card; kept as printed.
- **Bandon Dunes:** only the Tournament tee comes from the resort's own site; the other tees come from matching third-party cards. One source says the greens have moved toward Poa annua.
- **TPC Sawgrass:** green depths for all 18 holes come from TPC's yardage guide, which prints no unit; yards is inferred and cross-checked against No. 17.
- **Hazeltine National** publishes no scorecard, so its yardages and ratings come from Stymie, checked against GolfPass and the 2024 U.S. Amateur fact sheet (Tournament tee 7,674 yd, 77.8/148). The 2016 Ryder Cup re-routed the course (holes 5–9 and 14–18 swapped); tournament setups are in notes. OB is documented on No. 5 (left) and No. 14 (right) only.
- **OB vs penalty areas** are separate fields. Most water, cliffs and gorse on these courses are penalty areas, not OB.

Each course's `gaps` list records the remaining conflicts between sources.

## Measuring what nobody publishes

The sim already has what it needs to measure the missing numbers for every hole. A cached course (`$BIRDIE_DATA_DIR/courses/<slug>.json`) holds `holes[]` with `tee` and `pin` points and the `ref` hole number, `surfaces[]` with green polygons (`kind: 'green'`, `poly`) in local metres, and the `elevation` grid. HD bundles add 1 m lidar where they are built.

- **Tee-to-green elevation:** build the terrain the way `lib/game.js` does and compare heights at the tee and the pin.
- **Green size:** area of the green polygon that contains the pin.
- **Green depth:** extent of that polygon along the tee-to-pin direction.

```js
// Sketch: run from the repo root with node, passing a cached course file.
const fs = require('fs');
const { makeTerrain } = require('./lib/elevation');

const course = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!course.elevation) throw new Error('course has no elevation grid');
const terrain = makeTerrain(course.elevation, course.elevation.patches || []);

const inPoly = ([x, y], poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const area = (poly) => Math.abs(poly.reduce((s, [x1, y1], i) => {
  const [x2, y2] = poly[(i + 1) % poly.length];
  return s + x1 * y2 - x2 * y1;
}, 0)) / 2;

for (const h of course.holes) {
  const dzM = terrain.h(h.pin[0], h.pin[1]) - terrain.h(h.tee[0], h.tee[1]); // + = uphill
  const green = course.surfaces.find((s) => s.kind === 'green' && inPoly(h.pin, s.poly));
  let depthYd = null;
  if (green) {
    const len = Math.hypot(h.pin[0] - h.tee[0], h.pin[1] - h.tee[1]);
    const ux = (h.pin[0] - h.tee[0]) / len, uy = (h.pin[1] - h.tee[1]) / len;
    const along = green.poly.map(([x, y]) => x * ux + y * uy);
    depthYd = Math.round((Math.max(...along) - Math.min(...along)) / 0.9144);
  }
  console.log(h.ref, {
    elevation_change_ft: Math.round(dzM * 3.28084),
    green_size_sqft: green ? Math.round(area(green.poly) * 10.7639) : null,
    green_depth_yards: depthYd,
  });
}
```

Caveats when comparing with the published figures:

- Where no HD bundle covers a hole, the base grid comes from coarse terrain tiles, so read small differences with care. The published drops (Chambers Bay Nos. 5, 9 and 14 at about 95–100 ft; Pebble Beach No. 7 at 40 ft; Hazeltine No. 10 at 40 ft or more) make good checks.
- OSM tee points are usually the back tee, while published drops can refer to a different tee.
- Shared double greens at St Andrews cover two holes, so their polygon area is the whole green, not one hole's half.

OB still needs human input: OSM's course outline is a property edge, not surveyed OB (see `lib/course.js`), and published local rules cover only the holes listed here.

## Rebuilding

Edit `courses/*.json`, then run from the repo root:

```bash
python3 docs/research/course-data/tools/check.py docs/research/course-data/courses/*.json
python3 docs/research/course-data/tools/build.py
```

`check.py` flags par mismatches for women's and tournament tee entries (St Andrews par 76, Pebble Beach's 2019 U.S. Open par 71); both are expected and explained above.
