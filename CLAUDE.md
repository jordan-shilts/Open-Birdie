# Open-Birdie — agent orientation

Open-data golf simulator: Node/Electron/Three.js, SSE server, real launch-monitor
integration (Open Connect). Runtime deps: `pngjs` + `three`, plus `3d-tiles-renderer` (loaded only
with a Google Map Tiles key). Heavy data tools (`geotiff`, `sharp`) stay out of the desktop runtime:
the cloud course service (`cloud/`) uses them. Shipping (v0.8.0).

## Resuming work — read these first
- **`docs/HANDOFF.md`** — the single source of truth for the current "make it look like a
  real place" arc (findings, what shipped, how the new pieces work, the QL1 gate decision,
  the verify/render loop, gotchas, and a prioritized backlog). **Start here.**
- **`docs/TODO.md`** — live backlog / resolved items.
- **`docs/research/course-data/`** — researched per-hole yardages, par, handicap, elevation, OB, penalty
  areas and green data for the seven featured courses, with a source for every fact.
- **`docs/machines.md`** — the dev Mac (M3 Pro, where perf is measured) vs the sim PC (a laptop that
  renders on Intel UHD 630). Say which machine a frame rate came from.
- Current feature branch: `claude/hd-discovery-plan4` (base `main`). Most realism work lives here.

## Dev essentials
- **Tests:** `npm test` (must stay green). **Node ≥ 22** — below 21 the `node --test` glob silently
  runs *zero* tests and reports green. `tools/test-shot.js` is a launch-monitor emulator, NOT a test.
- **Run the app:** `npm start` (Electron desktop) or `node server.js` → http://localhost:8222.
  Double-click `Open-Birdie.bat` for the desktop app.
- **Data dir:** `BIRDIE_DATA_DIR` (cached courses, HD bundles, aerials). `data/` is gitignored and
  lives on disk — regenerate via the tools in `docs/HANDOFF.md` §6 if lost.
- **No hot-reload:** any `server.js` / `lib/**` change or new HD bundle needs a server **restart**;
  client (`public/**`) changes need a page reload.

## Conventions that bite if ignored
- **HD fingerprint:** `course.{buildings,aerial,elevation.patches}` are *scenery* and deliberately
  NOT in `canonicalCourse` (`lib/hd-bundle.js`) — attaching them never invalidates an HD bundle.
  Do **not** add them to the fingerprint, and do **not** bump `CACHE_VERSION` or shift the projection
  origin casually (both change `courseFingerprint` and break every built HD bundle).
- Match existing style; keep changes surgical; verify visual changes via the render loop in
  `docs/HANDOFF.md` §6 (never claim a visual fix without a captured frame).
