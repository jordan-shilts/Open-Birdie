# Changelog

All notable changes to Open-Birdie are documented here.

## [Unreleased]

### Changed
- **The overhead map shows the hole you're on, and only that hole** — course surfaces carry no hole of
  their own, so each now goes to the hole whose line of play runs nearest it: this hole's tees, fairway,
  green and hazards are drawn in full, every other hole's fade into the rough, and a soft light along this
  hole's corridor (tee to green, and ball to pin) keeps the eye on it. A neighbouring tee or green no longer
  reads as part of this hole (`yardages.mjs` `holeSurfaces`, `aim-map.js`).
- **AUTO aims for the safe spot** — the middle of the green when the club gets there (the point furthest
  inside the green, not the pin), else the middle of this hole's fairway where the ball comes down, else
  the hole's line of play, wind and shape allowed for (`lib/safe-spot.js`, `lib/predict.js` aimAssist).
  Doglegs and holes played over water or trees now get a fairway to aim at instead of the straight line to
  the pin; AUTO says where it aims ("Aiming at the middle of the fairway"), and the map marks the spot
  (AUTO · FAIRWAY) until the aim is moved. Putts still read the line to the cup.
- **Short shots are planned as partial swings** — inside the shortest full shot in the bag (a lob wedge's
  full carry), the planner showed a full swing of the club in hand, so a 15 yd chip read as an 80 yd landing
  band. Each club is now predicted as the partial swing that finishes at the pin: its own launch with less
  ball speed and spin, in proportion, with the ball speed to aim for ("34 mph ball speed to the pin · full
  carries 76") and a landing band that shrinks with the swing. A 7-iron chips and runs, a lob wedge flies.
  Further out every club is still swung in full, so a club that flies the green still shows it
  (`lib/predict.js` `partialSwing`).
- **Aiming in yards** — the aim reads as yards left or right of the pin at the club's carry ("7 yd L", "On
  pin") on the bottom bar and on the map, where the aim line runs solid to a target ring at the carry and
  faint beyond; a ghost line shows where a click would aim, and a double-click aims back at the pin.
### Added
- **Players and leagues** — a roster of everyone who plays on the simulator (a name and an optional handicap
  index; the round card is the player switcher), and leagues: some of the roster playing a season of weeks, a
  course each week, scored net or gross. A league round starts from the week's board (Play, per player; the
  week's course loads if it isn't the one in play) and its card posts itself when the round is finished; the
  first card a player finishes for a week is the one that counts. Each week pays 10 · 8 · 6 · 5 · 4 · 3 · 2
  points for 1st to 7th and 1 for every other card, ties sharing, and the standings add them up with cards
  played, average to par, best round and weeks won. Kept in `DATA_DIR/leagues.json` (`lib/leagues.js`,
  `public/leagues-ui.js`, `/api/players*`, `/api/leagues*`).

### Fixed
- **Lakes beside the course are water, not dry ground** — the lakes fetched around a course (Lake Hazeltine,
  beside 16–18) were drawn but played as rough, so a drive that splashed into the lake on 16 sat on the
  water and was played from there. A lake that reaches the course (inside its outline or within the 15 m
  out-of-bounds buffer of it, or any lake when the outline can't be trusted, as at Hazeltine) is now a
  penalty area, all of it, even where it runs past the outline; a pond wholly beyond the outline stays out
  of bounds. The prediction, the safe spot and the map's hazard yardages count those lakes too
  (`lib/course.js` `lakesInPlay`).
- **A ball in the water is dropped where it crossed the edge** — the lateral drop was taken around the spot
  where the ball came down, so a ball that flew far into a lake found only water within reach and was
  replayed from where it was hit. The drop is now beside the last point of its path over dry ground, as the
  rules have it (`lib/game.js`).
- **A tree no longer stretches the landing area across the whole hole** — the predicted landing and
  resting areas come from launches one sigma either side of the typical one, and when one of those met a
  tree the shot itself flies clear of, its drop 35 yd out stretched a drive's area to 615 yd ("lands
  35–558 yd" on Hazeltine's 14th). Such a launch now gives way to its clean twin, and no one launch moves
  the ball more than a fifth of the way it goes in that estimate (`lib/predict.js` `spreadCov`).
- **The range & games board stays clear of the last shot** — since the lineup HUD, the board and the last-shot
  panel shared the top-left corner and drew over each other. While a game is on, the last shot now stacks under
  the board (and steps aside when the board leaves it no room), and both board buttons fit its width. Where a
  practice green is mapped under the range's tee (Hazeltine), the lineup read every range ball as a putt and
  picked the putter; the range spot now plays as the tee it is (`lib/predict.js`).
- **The launch monitor keeps the club you pick on it** — after every shot Open-Birdie sent the monitor a
  player update with the new distance to the pin, and that update repeated Open-Birdie's own club (Driver
  unless picked here); OpenFlight applies the club from every update, so a club chosen on the monitor
  snapped back to Driver after each shot. Updates now carry only what changed; a club is sent when it is
  picked in Open-Birdie (`lib/openconnect.js`).

### Changed
- **No more grass fuzz** — the camera grass field is off (`config.js` `grassField`), with the older ball
  patch it had replaced, and parkland courses no longer scatter tall fescue tufts in the mown rough: from the
  play cameras the blades read as a dark speckle around the tee and in the rough, and the tufts as stray
  wisps, not grass. The turf carries the grass on its own (below). That frees 0.7-2.2 ms a frame on an Apple
  M3 Pro at ~1080p internal, where shots now run at ~79-81 fps (p95 frame ~15.5 ms). Links courses keep their
  golden fescue. Switched back on, the field draws only where the camera looks: each ring is fitted to the
  view every frame and fades by true distance (`grass-field.js`, `scene.js`, `quality.js`).
- **Ground with wear and structure** (`turf.js` v42) — tee boxes and fairways carry sand-and-seed filled
  divots (one chance per 0.6 m cell: about 0.8 a square metre on a tee, bunched where shots come down on a
  fairway; `divots.js`, which the grass field also reads, when on, to grow no blades in them). The tee box
  ends at a crisp mow line instead of glowing into the rough (the aerial photo's tint is held back over the
  rough round it). The rough is mown in faint ~5 m passes, at half the fairway stripes' strength, with 3-7 m
  lush/thin patches, so the slopes stop reading as felt. The turf additions cost 0.1-0.3 ms.
- **4K at 60 fps by dynamic resolution** — High now renders up to native 4K, and the render resolution
  follows the frame rate: a window of slow frames steps it down (to half per axis at most), a run of calm
  ones creeps it back up, and Auto only falls to Low once the scale is spent. Changes wait until the camera
  is back at address (a resize reallocates every full-screen target — ~0.5 s at 4K — so never mid-flight),
  big screens start near 1080p worth of pixels, and a contrast-adaptive sharpening pass (after AMD CAS)
  restores detail in proportion to the upscale (`quality.js`, `scene.js`, `postfx.js`). On an Apple M3 Pro at
  a 4K output it holds ~57 fps through a shot at a 1080p internal resolution; native 4K needs a desktop GPU.
- **Terrain detail by distance** — the coarse grid draws as 256 m tiles at 2, 4 or 8 m by distance (tiles
  touching an HD hole keep full detail so its cutout stays exact) and each 1 m HD hole has a 2 m level past
  240 m; tiles behind the camera are culled. Every level hangs a 1.5 m skirt under its edges, which closes
  the see-through cracks where HD holes met the coarse grid (the dotted line along HD tile edges). All levels
  upload while the course loads (a level first drawn mid-flight stalled ~0.3 s). Triangles per frame on
  Hazeltine: 16 M -> 8-12 M (`hd-terrain.js`).
- **Water depth pre-pass only near ponds** — the terrain depth pass behind the pond shallows runs only with a
  pond within 300 m in view (it redrew the whole terrain whenever any pond was on screen) (`water.js`).
- **The flight camera zooms in on the drop** — wide through the launch and climb, then the lens closes in
  1.8x from the apex to touchdown so the falling ball and its landing spot fill the frame, easing partly back
  out over the roll; the landing vantage also sits closer (`flight-camera.js`).
- **Daylight that shows the ground** — the default sun sits at 24° (was 36°), a little warmer, with less sky
  fill, so the 1 m lidar relief reads: mounds, swales, green slopes and bunker faces get a lit and a shaded
  side, and tree shadows run long across the fairways (`sky-presets.js`, `config.js`).
- **Turf that behaves like grass** (`turf.js` v39) — mow stripes and the green's checker are a sheen that
  depends on where you stand (a band is light looking down its grain and dark against it, and the bands
  swap as you walk round), grass brightens with the sun behind you and darkens looking into it, and the
  blade texture has real tooth near the player. The palette moved from kelly/lime to olive green, and tees
  sit in the fairway family instead of glowing above it (`course-character.js`).
- **Grass blades that read** — the camera's blade field shades each clump dark at the root and bright at
  the tips, with some older, yellower clumps, slightly wider blades and a longer reach (`grass-field.js`).
- **Windows that reflect the sky** — glass lifts the sky reflection and some rooms show blinds or lights,
  instead of every pane being black (`buildings.js`).
- **Cheaper pond mirrors** — the live water mirrors no longer redraw grass blades, flowers or litter (a pond
  can't show them) (`water.js`).
- **Smooth ball flights** (measured on two simulated shots on Hazeltine at High, 1920x1143, Apple M3 Pro:
  48-49 -> 59-60 fps average; the worst frame 485 -> 35 ms):
  - the shot tracer, glows, apex drop line and landing ring compiled their shaders the first time they drew,
    mid-flight (~0.45 s stalls at launch, apex and landing); every program is now compiled while the course
    loads, against the HDR target the frame really draws into, and each effect is drawn once (sub-millimetre)
    so the GPU pipeline exists too; one tracer material stays alive so its program survives each shot;
  - GTAO reads the main pass's depth and rebuilds normals from it instead of drawing the whole course into
    its own buffers (fades out 35-70 m, where depth-only normals printed halos behind trees);
  - the pond mirrors draw a 6 m stand-in for the terrain (the full terrain is ~3.7 M triangles on an HD
    course) and render at 512 px; triangles per frame 29 M -> 16 M;
  - the shadow map is cached: it redraws only for a new hole, sky or scenery, at most ~10x a second while
    the near trees follow a moving camera, and twice a second regardless (the ball's contact shadow is the
    soft blob, so the ball no longer forces a redraw every frame);
  - the HUD panels no longer use a backdrop blur over the live canvas (the compositor re-blurred them as the
    frame changed: every ~5th frame took twice as long), with a little more opacity instead;
  - turf: the collar taps run only within 70 m, the rough's own noise only on rough, the sun-play roll uses
    two octaves.
- **Faster turf** — the turf shader's ~65 noise samples a pixel read one texture tap each instead of four
  `sin()` hashes (same smoothstep value noise). With the mirror change, frames are 10-12% faster on Hazeltine
  (25.1 -> 22.5 ms at a tee with ponds in view, 21.6 -> 19.1 ms at a green; 1600x900, Apple M3 Pro).

### Added
- **Mulligans** — after a round shot lands, Mulligan in the bottom bar (or M) takes it back: the ball,
  strokes, aim and score go back to how they stood before it, and the scorecard counts it on that hole (a
  Mull. row, and a chip in the round summary). One shot back, only on the hole being played, never on the
  range (`lib/game.js` `mulligan`, `POST /api/mulligan`).
- **Saved shots** — ★ Save on the last-shot panel (or in the new Saved panel) keeps a shot with its launch,
  its result and its flight in `DATA_DIR/saved-shots.json` (the newest 200). Saved lists them, and Replay
  flies one again from where it was hit on the loaded course, side view and all, without touching the round;
  a live shot that comes in mid-replay ends the replay first (`lib/saved-shots.js`, `/api/saved-shots`).
- **Three more mini games** (`lib/practice.js`). **Putting challenge**: 9 putts at a real cup, the green of the
  hole the round is on (else hole 1's): 3, 5, 8, 12, 16, 20, 25, 30 and 40 ft, each from its own side of the
  cup and on the green all the way to it (on a green too small for the long ones they come in to the longest
  it has); most holed wins, the fewest feet left breaks a tie. **Up and down**: 6 chips from 1-9 m off the
  same green, 8-30 yd from the cup and all round it, from the fairway or the rough (never sand, water or out
  of bounds); 10 points for a chip-in, 5 / 3 / 2 / 1 inside 3 / 6 / 10 / 20 ft. **Distance ladder**: flags at
  50 to 175 yd on the range, 25 yd apart; a ball that stops within 7 yd of the current one climbs to the next;
  12 balls, and clearing all six ends it. Each new ball round the green re-frames the camera behind it, facing
  the cup; the board says what's next ("putt 4 of 9 · 12 ft", "rung 4 of 6 · 125 yd").
- **Trees grown from real branch structures** — every species (oak, maple, birch, pine, spruce/fir) has
  three generated models, two open-grown and one grown in closed woods (`tree-gen.js`): broadleaves grow by
  space colonization inside a lobed crown, spruce has whorls of drooping branches, pine a bare bole under
  layered limbs ending in needle tufts. Leaf cards are cut from photographed CC0 leaves and needle sprays
  composed into an atlas at load (`leaf-atlas.js`). The far levels of detail are the same model with fewer,
  larger cards (crossed at the far level), so a tree keeps its silhouette to the horizon instead of turning
  into a solid "lollipop". Crowded trees get the woods-grown model; maple joins the species mix.
- **Ponds that mirror the course** — water sits at the pond's real (hydro-flattened lidar) water line over a
  bed carved into the render terrain, grown past the OSM outline so the bank draws the shore
  (`water-shore.js`). The two ponds that matter most on screen keep live planar mirrors, refreshed in turns;
  calm ripples distort the reflection and drive the sun glitter, Fresnel mixes it with a dark water body, and
  the shallows clear over a silty bed. Lakes around the course (`sceneryWater`) render the same way.
- **Grass blades around the camera** — a GPU field of blade clumps follows the camera over every mown and
  rough surface (short on fairways and tees, longer in the rough, none on greens, sand or water), in the
  turf's own colour, snapped to world cells so nothing swims (`grass-field.js`).
- **Time of day** — a **Sky: Morning / Midday / Golden hour** button (saved; `?sky=` overrides). Each preset is
  a CC0 Poly Haven sky photo plus its light: sun colour and strength, sky fill, exposure, haze; the sun's
  direction comes from the photo (`sky-presets.js`). Morning and golden hour download on first use.
- **Buildings with real roofs and windows** — gabled or hipped roofs along each house's long axis, inset hip
  roofs for L-shaped and irregular buildings (the clubhouse), flat roofs behind parapets for big blocks;
  roofs coloured from the aerial photo above them; a facade shader with storeys of windows. All buildings are
  two meshes (`building-shapes.js`, `buildings.js`).
- **1 m terrain for Hazeltine 16-18** — HD manifests (1 m 3DEP lidar, 0.3 m NAIP 2023-07-31).
- **The ball hits the course's real trees** — the trees the renderer draws (canopy trees, plus OSM tree
  points no canopy tree already covers) are obstacles, indexed once per course on an 8 m grid
  (`lib/tree-obstacles.js`). Trunks are solid up to the crown (radius 0.12 + 0.01 × height): the ball
  bounces off at restitution 0.4–0.5 and loses most of its spin, in flight or rolling. Each crown is fitted
  to the generated model drawn there (`tree-gen.js`; open- or woods-grown form, sized like the renderer
  sizes it): an ellipsoid around the leaf mass, a cone for firs, whose skirt can catch a rolling ball.
  Crowns are porous: 0.25–0.4 branch hits per metre inside, each keeping 20–60% of the speed and throwing
  the ball down and back, so it usually drops out under the tree. The luck is seeded by the shot, so a
  replay plays out identically, and a shot no tree reaches is bit-for-bit unchanged. Hits are `tree` shot
  events (`part: 'crown' | 'trunk'`); the HUD calls out "Tree!" as the replay reaches the first one.
- **Hole flyover** — the **Flyover** button or **F** flies the current hole like a TV broadcast:
  a dip to black, low behind the tee, a climb to 40–60 m along the hole line (doglegs included)
  looking ahead, a descent toward the flag, then a cut back to the address view. 8–14 s by hole
  length on centripetal Catmull-Rom curves with an eased cruise; it lifts over tree crowns and
  terrain, and any key or click skips it (`public/render/flyover.js`).
- **Optional Google 3D surroundings** — with your own Map Tiles API key in `GOOGLE_MAPS_API_KEY`,
  Google Photorealistic 3D Tiles fill in the real houses, trees and lakes around the course
  (`3d-tiles-renderer`, loaded only when a key is set). Inside the course rectangle our own
  terrain, trees and buildings win (a dithered seam), the tiles are lifted or lowered to meet our
  terrain (raycast heights around the edge), our countryside apron and horizon band step aside,
  fog still fades them into the haze, and the Google logo + data attributions show next to the
  course credit. No key: no requests to Google and no change. A bad key logs one warning
  (`public/render/google-tiles.js`, `lib/google-tiles-config.js`).
- **Automatic scenery for every course** — buildings, real trees and the aerial photo no longer need the
  `tools/add-*.mjs` scripts: after a course is playable (cache miss or hit), whatever it is missing is
  fetched in the background in order (buildings first, so footprints mask false tree crowns), saved to the
  course cache layer by layer, and pushed to the screen with a new `scenery` SSE event (the client re-reads
  the geometry and rebuilds the scene in place, keeping the hole and the round). Canopy needs `geotiff`,
  which the packaged app lacks, so it skips there until the cloud supplies it. A source with no data
  (no NAIP outside the US) is remembered; a failed fetch is retried after 10 minutes. `BIRDIE_ENRICH=0`
  turns it off. The tools are now thin wrappers over `lib/buildings-fetch.js`, `lib/canopy-fetch.js` and
  `lib/aerial.js` (`fetchCourseAerialTiled`); orchestration is `lib/course-enrichment.js`.
- **Course packages + a bounded local cache** — `lib/course-package.js` defines a portable course package:
  a manifest (key, source, fingerprints, scenery summary, `complete`, `packageId`, and every file's size,
  sha256 and content type) plus the gzipped course JSON, aerial, classmap and matching HD bundles. Installs
  verify every file before writing anything and write the course JSON last. `lib/course-cache.js` keeps the
  local cache under `BIRDIE_CACHE_MAX_MB` (default 1024): least recently played courses are evicted, never
  the active one; surface overrides, legacy caches and locally compiled HD bundles are never touched.
- **Courses from the cloud** (`lib/cloud-client.js`) — with `BIRDIE_CLOUD_URL` set, a course that is not cached
  locally is downloaded as a package (each file verified against its sha256, presigned redirects followed) and
  installed into the bounded cache, then activated through the normal path. If the cloud lacks it, the cloud is
  asked to build it (`BIRDIE_CLOUD_BUILD_TOKEN`) and its progress shows in the course picker; the course is
  playable as soon as the cloud publishes the base package, and buildings/trees/aerial follow as the cloud adds
  them (`scenery` event). Cached courses get their scenery from the cloud package too, re-projected exactly when
  the local copy was built from a different OSM snapshot. An unreachable cloud or a failed verification falls
  back to building on this computer; a cloud verdict that the course is not playable is shown as is. Without
  `BIRDIE_CLOUD_URL` nothing changes and no cloud request is made.
- **Cloud course service** (`cloud/`) — `node cloud/server.js` builds each course once with the same `lib/` code
  plus canopy (`geotiff`) and the max-quality tiled aerial (`sharp`), publishes a playable package as soon as the
  base data is ready and the complete one after the scenery, and serves them: `GET /v1/courses/:key`,
  token-gated `POST /v1/courses`, `GET /v1/jobs/:id`, `GET /v1/courses/:key/files/:sha256` (302 to a presigned
  URL, or proxied). Object storage through the S3 API, SigV4-signed with `node:crypto` (checked against AWS's
  published signatures), or a directory; files are content-addressed so unchanged files upload once. One build
  per course, a small in-memory queue, resume from the published package after a restart, failed layers retried
  after an hour, and packages from before a new scenery layer upgraded on request. `cloud/Dockerfile`
  (`node:22-slim`) and a README section on deploying to Railway (service + bucket), R2, Supabase or MinIO.
- **The cloud service on Vercel** — the same v1 API as a Vercel Function (`api/index.js`) over a public Vercel Blob
  store (`cloud/vercel-blob-store.js`); a Function can't run a 5–10 minute build, so each build gets its own
  Vercel Sandbox that clones the repository, installs `cloud/package.json` and runs `cloud/sandbox-build.js`,
  reporting progress into job records in the store (`cloud/sandbox-jobs.js`). Files download straight from the
  Blob CDN. Sized for the Hobby plan: progress saved at most every 15 s and the desktop asked to poll every 10 s
  (a job's `pollMs`), since each is a metered Blob operation. `node cloud/vercel/stage.js <dir>` assembles the
  deployment. The desktop can keep its cloud in `data/cloud.json` (`{"url", "buildToken"}`, gitignored) instead
  of environment variables. A failed build keeps its cause (and the warnings before it) in the job record, which
  the API logs but never serves.
- **Courses built ahead of time** — `npm run cloud:build-courses` (`tools/cloud-build-courses.mjs`) asks the cloud
  to build courses before anyone picks them: by default the featured list (`courses/featured.json`: the picker's
  suggestions plus the courses with HD hole manifests), or any names (searched on OSM) or OSM ids. It skips what
  the cloud already has and follows each build; `--status`, `--force`, `--concurrency`.
- **HD holes built in the cloud** (`cloud/hd-holes.js`) — a cloud build compiles the 1 m lidar + 0.3 m NAIP hole
  bundles for every hole manifest in `tools/hd-course/manifests` that names the course, re-resolving each against
  the course just built (`discoverAndBuildHole`), and ships them in the package (`manifest.hd` lists the holes).
  Courses already in the cloud are upgraded in place: a build request's `hd` lists the holes wanted, and the build
  resumes from the package and adds only the missing ones. The job record says which holes were built and which
  were skipped, with the reason. A failing hole is skipped; HD stops starting holes after 20 minutes. The HD
  compiler gives 3DEP's 1 m export 60 s and three tries (a course load allows 12 s, which cost cloud builds
  holes). The Chambers Bay, Bandon Dunes and TPC Sawgrass manifests now name their course by OSM id.
- **HD for every hole of a US course** (`tools/hd-course/auto-pin.mjs`) — holes without a reviewed manifest are
  pinned automatically to the newest single-date NAIP acquisition covering their padded bounds and built like any
  other (3 m terrain where there is no 1 m lidar); `BIRDIE_CLOUD_AUTO_HD=0` turns it off. The cloud publishes the
  complete package before the HD stage and again after, and packages record `hdPlanned` and `hdMissing` (hole +
  reason). `npm run auto-pin:hd-hole` writes or re-pins manifests; Bandon Dunes hole 1 is re-pinned (its 2022 pin
  had left the catalog).
- **Range & games** (`lib/practice.js`) — a driving range and three mini games on the loaded course, its real
  ground and physics; the round pauses and resumes untouched. The range is the course's own mapped
  `golf=driving_range` (played along its long axis from the end by the first tee), else hole 1's tee, with yellow
  yardage flags every 50 yd, a shot table and club averages. Closest to the pin: 5 balls at a par 3. Long drive:
  6 drives inside a 50 yd grid. Target challenge: 10 balls at random flags, 10/5/3/1 points.
- **Lakes and ponds around the course** — course data only carries water mapped near the course itself, so a lake
  OSM maps as a multipolygon beside the holes (Lake Hazeltine, by 16–18) was missing and showed as the flat,
  hydro-flattened lidar ground. A new scenery layer (`lib/water-fetch.js`) fetches every `natural=water` /
  `water=lake|pond|reservoir` / `landuse=reservoir` area over the elevation grid, assembles relation outlines from
  their outer ways, projects them with the course origin, clips them to the grid and drops outlines already in
  `course.surfaces`. Stored as `course.scenery.water` (never `surfaces`: drawn, not played, not fingerprinted),
  served as `sceneryWater` in `/api/course-geometry`; canopy trees are masked on it.
- **Real trees from canopy height data** — `tools/add-canopy-trees.mjs` streams the Meta & WRI 1 m
  global canopy height map (CC BY 4.0) for a course and writes `course.canopy`: every tree's position,
  height and crown radius (distinct crowns, plus a fill for closed woods). The renderer places and sizes
  trees from it instead of guessing woods fills; crown shape picks conifer vs broadleaf. Hazeltine:
  7,854 real trees. Non-fingerprinted scenery (`lib/canopy-trees.js`, `tree-placement.js`, `trees.js`).
- **`tools/refresh-elevation.mjs`** re-fetches a cached course's lidar terrain.
- **Clean parkland turf + sun-dominant daylight** — the sky dome was the main light (env 1.0 vs sun 2.0),
  so courses read as soft, shadowless haze with blotchy grass; the sun now keys the scene (5.0 vs 0.4, sun
  altitude 36°) with crisp tree shadows. Parkland turf drops the stacked noise, straw patches, near-camera
  aerial tint and links desaturation (`turfClean`, scaled out on dry courses), tees are painted crisp,
  stripes are a softer 4.5 m sheen, parkland sand is white silica, and terrain shading uses lightly smoothed
  normals (`terrainShadeSmoothM`).
- **Graphics upgrade (branch `feat/graphics-upgrade`)** — instanced 3D trees with near/mid/far LODs, wind
  and filled woods (`trees.js`, `tree-placement.js`); a rough / first-cut / tee / wet-bank / sun-aware
  bunker-lip ground pass (`turf.js`); a countryside apron + horizon haze and an aerial-perspective fog curve
  so the course no longer floats in a sky sphere (`horizon.js`, `atmosphere.js`); a glowing shot tracer
  with apex/landing callouts, a ball contact shadow and a follow camera (`shot-fx.js`, `flight-camera.js`);
  a HUD **side-view flight panel** with ghost lines of earlier shots on the hole (`flight-view.js`); a cloth
  flag with the hole number and tee markers (`pin-flag.js`); and a **Graphics: Auto / High / Low** setting
  with a 1080p pixel budget and an auto-downshift on slow machines (`quality.js`). No new downloaded assets.
- **Auto-fetch the course aerial on load (turnkey for any US course)** — the ground photo now downloads
  automatically during course load (like the 1 m terrain already does), so a freshly loaded US course
  renders real imagery over its 1 m relief with zero manual steps. Runtime path uses a single USGS NAIPPlus
  request (no image deps, ~0.3 m up to ~1.2 km courses, ~0.45 m for larger), written to the course cache and
  served by the existing `/api/course-aerial`. Best-effort: a failed/non-US fetch just falls back to
  procedural turf, never blocking load. The tiled max-quality 0.3 m mosaic stays in
  `tools/add-course-aerial.mjs`. (`lib/aerial.js`, `lib/course.js loadCourse`.)
- **Volumetric trees + pitched building roofs (Phase 2 — above-ground objects)** — trees now render a
  solid low-poly canopy core (cone for conifers, jittered blob for broadleaf) behind the foliage cards,
  so they read as real 3D volume from the overhead/orbit camera instead of thin cards; buildings get
  pitched hip roofs (each footprint fans up to a peak) instead of flat caps. The remaining gap that
  1 m lidar can't fill — objects above the ground. (`public/render/tree-cards.js`, `scene.js _addBuildings`.)
- **Real 3D terrain on every pixel (course-wide 1 m lidar)** — the base terrain now fetches USGS
  3DEP 1 m lidar across the WHOLE course (tiled + mosaicked, with a per-node fall back to the coarse
  ~9.5 m grid over water / outside the US), so every hole, fairway, and rough renders as genuinely
  sculpted landform — mounds, bunker pits, green contours — not an aerial draped on a smooth sheet.
  Chambers Bay goes from a 217×363 @ 5 m grid to 1081×1816 @ 1 m (~2 M nodes). Physics samples the
  finer relief too. (`lib/elevation.js` `fetch3depBase`/`planLidarTiles`; `CACHE_VERSION` 4.)
- **Multi-patch HD rendering** — the runtime renders every built hole's 1 m HD bundle at once
  (`resolveHdBundles` scans the bundles dir; server `activeHd` is an array; `/api/course-geometry`
  `hd` + the readiness handshake are plural; the client builds one HD mesh per patch with
  overlap-clipping). Previously only `active.json`'s single hole rendered.
- **Sharper course aerial (0.6 m → 0.3 m, USGS NAIPPlus)** — the course-wide ground photo now comes
  from High-Resolution Orthoimagery (~0.3 m over urban areas), tiled past the export-size cap and
  mosaicked, so greens / sand / bunkers / cart paths read distinctly; the turf shader leans more on
  the real photo (course-aerial weight 0.90 close / 0.99 far). (`tools/add-course-aerial.mjs`, `scene.js`.)
- **HD hole compiler — foundation (Plan 1)** — the offline contract layer for compiling real
  public geodata (USGS 3DEP elevation + USDA NAIP imagery + cached OSM) into versioned, immutable
  hole bundles the runtime loads with no network. This phase is scaffolding only — no data is
  fetched or rendered yet (that is Plans 2–3):
  - Strict, stage-coded `HdCompileError` with URL/token redaction, cross-platform path-traversal
    guards, and a fail-closed bounded HTTP primitive (`tools/hd-course/{errors,paths,http}.mjs`).
  - A reproducible build-manifest schema + loader and a canonical course fingerprint that excludes
    generated HD green patches; the pinned Bandon Hole 1 manifest ships `discovered:"pending"`
    until a later discovery command resolves bounds/ETags (`tools/hd-course/{config,course-source}.mjs`).
  - A dependency-light runtime bundle validator returning typed `absent | rejected | valid` status,
    with little-endian Float32 terrain decode and hand-rolled PNG/WebP/JPEG header checks
    (`lib/hd-bundle.js`), plus an atomic immutable bundle publisher (`tools/hd-course/publisher.mjs`).
  - Toolchain raised to **Node 22** (drops EOL Node 18) with a Windows CI gate; 54 new offline tests.
- **HD hole compiler — provider ingestion (Plan 2)** — the compiler now ingests real data
  (still offline scaffolding; the live Bandon build is an opt-in capstone):
  - Shared coordinate/grid contracts (local↔WGS84↔UTM, snap to coarse + HD cell lines).
  - Strict 3DEP terrain acquisition — `lib/lidar.js` gains a throwing `fetchPatchStrict`; gameplay's
    best-effort `fetchPatch` is unchanged. Rejects data coarser than the pinned native spacing.
  - Range-only NAIP COG reads via a custom geotiff client bounded to ≤2 in-flight requests — never a
    full-object download — with deterministic pinned-item selection and ETag/length drift guards.
  - UTM→local imagery reprojection (corner-color tested), pure-JS semantic masks, pinned-LUT
    normalization, and deterministic encoding (`terrain.f32` byte-reproducible).
  - An 11-stage compiler behind `npm run build:hd-hole` that validates each staged bundle against the
    Plan 1 runtime validator before the atomic publisher swaps it in. +52 offline tests (151 total).
- **HD hole compiler — runtime integration (Plan 3)** — loads a validated bundle into the live game so
  a compiled hole becomes *viewable*:
  - Physics terrain injection — render and physics ground heights identical (raw h / smoothed grad),
    plus a real NaN-guard fix for a compiler-pre-blended (`edgeBlendM:0`) patch at its exact boundary.
  - Secure asset serving — `GET|HEAD /api/hd-assets/<id>/<key>`, key-allow-listed + range-safe, with no
    path/height leak through course JSON.
  - A verified browser loader (SHA-256 + dimensions, all-or-nothing, idempotent dispose).
  - A unified HD terrain mesh — coarse cells removed inside the snapped HD rect + the HD mesh filling
    it with zero positive-area overlap; the browser sampler has parity with physics.
  - Aerial macro color layered into the PBR turf shader (low-frequency tint; detail/stripes survive).
  - A course-revision readiness handshake (loopback nonce, constant-time compare, bounded-timeout
    procedural fallback) so HD physics activates only after the matching scene is ready.
  - +37 offline tests (188 total). The browser render path is verified in the running app (Plan 4).
- **HD hole compiler — manifest discovery + first live render (Plan 4)** — the pipeline now produces and
  renders a *real* hole bundle end-to-end from open data:
  - A `discover` command (`npm run discover:hd-hole`) resolves a `pending` build manifest into a buildable
    one — pins the canonical course fingerprint, the snapped compilation bounds, and each NAIP tile's live
    content-length + ETag (`tools/hd-course/discover.mjs`). Provider calls are injected so the resolver is
    unit-tested offline; the committed Bandon Hole 1 manifest is now resolved.
  - First live **Bandon Dunes Hole 1** build against USGS 3DEP (≈3 m) + USDA NAIP (0.3 m, 2022), verified
    on screen in the running app — real aerial (fairway mow lines, the green, gorse, waste bunkers) draped
    on continuous high-resolution terrain. This shakes out the previously untested live provider wiring.
  - Two render-wiring bugs the live build surfaced, now fixed: the HD patch edge ring blended toward 0
    instead of the coarse terrain (a baked zero-ring seam cliff) — it now blends to the coarse grid via the
    runtime's shared `gridSampler`, so the patch sits flush; and the legacy LIDAR green patches crashed on
    the HD terrain Group — now cleanly skipped when an HD bundle is active (the aerial supplies the greens).
  - +6 offline tests (194 total).
- **Renderer quality pass (A–G)** — a sweep to take the runtime-procedural course from
  "indie sim" toward a convincing ~6–7/10 (photoreal-named-course specifics remain a future
  baked-content phase). Each system is a `public/render/config.js` flag so it can be toggled:
  - **Planar water reflections** — each pond gets a `THREE.Reflector`, so the tree line and
    banks mirror in the water instead of only the flat sky (`config.waterReflect`, `water.js`).
  - **Richer turf** — multi-scale colour mottling + a mid-scale clump octave + grass-blade
    chroma + a cross-cut mow pattern, so fairways/greens read as varied turf rather than a
    flat carpet (`turf.js`).
  - **Vegetation** — warm pine-straw litter mats under the on-course trees and vivid azalea
    flower beds at the tree lines that frame each hole (`config.pineStraw`, `config.flowers`,
    `vegetation.js`).
  - **Forest framing** — a denser, taller perimeter tree wall so each hole reads as carved out
    of pines, with a touch more aerial-fog depth.
  - **Bunker rakes** — an instanced rake in each sand bunker (`config.props`, `props.js`).
  - **LIDAR green relief** (Phase 1) — real USGS 3DEP elevation drapes finer green meshes so
    putting-surface contours show (`lib/lidar.js`, `lib/elevation.js`).
  - **Foreground grass objects** — a camera-anchored patch of short, dense, distance-faded
    grass blades on the mown corridor (fairway/tee — never greens or rough, which has its own
    fescue), tinted per-instance from the turf zone underneath so the near foreground reads as
    real grass instead of a smooth surface. Blades collapse to nothing past ~22m from the
    camera, so the mid/far field stays the proven shaded turf (no sub-pixel blade smear) and the
    patch re-anchors as the ball moves down the hole (`config.foregroundGrass` + radius/cap/
    height/fade knobs, `grass.js` `buildGrass` `colorAt`/`cameraFade`, `scene.js`).

### Changed
- **Ball flight now matches the OpenFlight launch monitor** — the air phase uses OpenFlight's model
  (Ferguson, McNally & McPhee 2022 Cd/Cl polynomials, 4%/s spin decay, RK4) instead of hand-tuned
  curves, so the carry shown on the monitor is where the ball lands (within 0.1 yd on flat ground).
  Drives and 3-woods fly 12–22 ft lower and 3–11 yd shorter; irons fly higher, land steeper (7-iron
  ~40° → ~46°) and carry 2–15 yd shorter, so they roll a little less. Bounce, roll and putting are
  unchanged. `test/flight-model.test.js` pins the parity (`lib/physics.js`).
- **GTAO ambient occlusion + filmic bloom enabled** — contact AO darkens tree bases, bunker
  lips and terrain folds; a restrained bloom lifts the hottest highlights (sun glints on water,
  bright sand) without hazing the sky (`config.gtao`, `postfx.js`).
- **Crisp bunkers** — bunkers render as their own sharp-edged polygon meshes with real sand
  PBR instead of a soft painted patch (`turf.js` `makeSandMaterial`, `drape.js`).
- **Turf lush + manicured + sheen finish pass** — play surfaces retuned toward a lush
  TrackMan-style green (fairway/green/base, plus a green Augusta-second-cut rough), with bolder
  cross-cut mow stripes, low-frequency procedural sun-play for gentle 3-D form, and a
  glitter-free specular sheen (smooth single-octave normal perturbation — fbm facets alias
  without TAA — distance-gated so the near turf stays matte instead of wet-vinyl). The
  multi-scale mottling and the dry-zone colour were then calmed so undulating holes read as
  clean lush fairway rather than churned mud (`turf.js`, `scene.js` `COLORS`).

### Fixed
- **A busy Overpass mirror read as "no such course"** — a mirror out of slots for the caller's IP (common from
  shared cloud machines) answers 200 with a runtime-error remark and no elements; that now counts as a busy mirror
  and the next one is tried.
- **Water was drawn in the wrong place** — pond meshes were mirrored across the x axis (the shape flipped y and
  then turned -90°), and the planar reflections faced sideways (Reflector reads its normal from the object's
  +Z, and the turn was baked into the geometry). What looked like water was turf painted blue.
- **Frame rate with water** — every visible pond re-rendered the whole course on every pass that drew it;
  Hazeltine's hole 17 tee went from 819 ms to ~25 ms a frame (M3 Pro, 1600x900).
- **Green haze** — the countryside past the course edge was a bare turf-green sheet; it now has woodlots, the
  haze is a touch bluer at ground level and thins as the camera climbs.
- Azalea beds no longer appear north of 37° (none in Minnesota); parkland rough tufts are green, not golden
  fescue; double-sided grass blades no longer render black; a gentler colour grade (saturation 1.16 -> 1.08).
- **Packaged app: three.js addons were missing** — electron-builder drops every dependency's
  `examples` folder, which removed `three/examples/jsm` (post-processing, loaders) from the asar,
  so the packaged renderer could not load. A build hook (`build/keep-three-addons.cjs`) keeps it;
  `examples/fonts` stays out.
- **Part of a course silently lost its lidar relief** — each 3DEP tile got one 12 s attempt; a slow reply
  dropped that whole area to the smoothed ~10 m terrain (Hazeltine holes 1, 9, 10, 18). Base tiles now get
  a 40 s deadline, 3 attempts with backoff, and a warning if one still fails (`lib/lidar.js`, `lib/elevation.js`).
- **Aerial colour tint stayed flat grey** — three.js sizes texture storage once, so growing the tint canvas
  from its 1x1 placeholder overflowed every upload; the texture is now disposed and re-uploaded (`scene.js`).
- **`add-buildings.mjs` could hang forever** on a silent mirror; it now uses the shared Overpass client.
- **Courses load when the usual map servers are busy** — every built-in Overpass mirror was at
  capacity or silent, so new courses failed to load. Added the maps.mail.ru mirror (it answers,
  but slowly) and gave each request time to finish: 45 s for lookups, 100 s for the feature query
  (was 20 s / 60 s, which cut off a slow-but-working mirror and then skipped it). New
  `BIRDIE_OVERPASS_URLS` puts your own mirrors first (`lib/course.js`).
- **No more fescue growing in bunkers** — bunkers map as islands inside a rough polygon, so the
  grass scatter used to sprout tufts in the sand; the scatter now excludes bunker/water areas
  (`scene.js` `_grassSpots`).
- **Course search returns the golf course, not a building next to it** — the server appended
  " golf" to every query, so the St Andrews quick pick matched the Old Course Starter Hut on
  "Golf Place" (and Pebble Beach / Whistling Straits hit a restaurant and a street). The query is
  now sent as typed, only `leisure=golf_course` results are listed, and a golf POI leads to the
  courses around it (`lib/course.js` `searchCourses`).
- **A non-golf-course feature is never loaded as a course** — loading checks the picked feature is
  `leisure=golf_course` and otherwise refuses with a clear message; the course boundary only
  defines OB if it is course-sized and holds every tee and pin, so a 3 m hut outline can no longer
  make every shot out of bounds (`loadCourse`, `makeSurfaceLookup`).
- **Course load no longer hangs on a busy Overpass mirror** — each mirror request has a timeout,
  busy answers are retried with backoff, and when every mirror fails the player is told so
  (`lib/course.js` `overpass`).

## [0.8.0] - 2026-06-21

### Added
- **One-click Windows installer** — `npm run dist` produces an NSIS installer
  (`Open-Birdie-Setup-<version>.exe`) via electron-builder: per-user install (no admin
  prompt), Start Menu + desktop shortcuts, launch-on-finish. Ships unsigned for now
  (Windows SmartScreen → "More info → Run anyway"); a code-signing cert drops in via the
  `CSC_LINK` env var with no rework. App icon generated offline from the existing `pngjs`
  dep (`tools/make-icon.js`, `npm run make-icon`).

### Fixed
- **Course cache works in a packaged build** — the cache lived at an `__dirname`-relative
  path that is read-only inside `app.asar` once packaged, so a packaged install couldn't
  cache downloaded courses. `lib/course.js` now resolves its data dir from `BIRDIE_DATA_DIR`,
  and `main.js` points that at per-user AppData when `app.isPackaged`. Dev (`npm start`) and
  headless (`node server.js`) are unchanged. Regression test added (`test/cache-path.test.js`).

## [0.7.1] - 2026-06-15

### Fixed
- **Malformed launch-monitor packets no longer corrupt the round** — `handleShot` now
  validates/sanitizes ball data and rejects implausible speeds, so one partial/garbage
  frame can't push `NaN` into the physics and permanently break play (it used to stay
  broken until restart). (`lib/game.js`)
- **A course with no playable holes is rejected, not loaded** — `parseOsm` throws and
  `setCourse` guards before mutating, so a bad OSM course can't wedge the app on every
  state read. (`lib/course.js`, `lib/game.js`)
- **Atomic course-cache writes + corrupt-cache recovery** — cache is written via temp+rename
  (an interrupted download no longer bricks startup), corrupt cache files are quarantined
  instead of silently vanishing, and a zero-hole cached course is ignored. (`lib/course.js`)

### Changed
- **HTTP server binds to localhost by default** — the unauthenticated API is no longer
  exposed to the LAN unless you opt in with `BIRDIE_HOST=0.0.0.0`. (`server.js`)
- **`BIRDIE_SPEED_SCALE`** corrects monitors that report ball speed in m/s (which played
  ~2.2× short, silently). (`server.js`)
- Added regression tests for the malformed-packet and zero-hole cases (`test/robustness.test.js`).

## [0.7.0] - 2026-06-15

### Changed
- **Waving pin flag** — the flagstick's flag is now a subdivided cloth rippled in the
  vertex shader (amplitude grows toward the free edge) instead of a rigid faceted cone —
  the shot's focal point now moves with the wind like the grass/trees/water
  (`public/render/scene.js`).
- **Calibrated color grade** — dropped the global blue shadow lift (it tinted turf shadows
  cyan and fought the grass palette) for a warm, slightly-desaturated shadow tone
  (`public/render/postfx.js`).
- **Foliage volume shading** — tree canopies now have a height gradient (dark, cool core
  and underside → bright, warm sunlit top) instead of flat uniform lighting, the biggest
  "video-game tree" fix (`public/render/tree-cards.js`).

### Added
- **Water shoreline foam** — a bright wet/shallows band hugs the waterline where terrain
  sits just under the surface. A one-draw terrain depth pre-pass (`public/render/water-depth.js`)
  feeds the water shader, which compares scene vs water eye-depth and whitens the shallow
  band (animated for a living edge). `config.waterFoam` (`public/render/water.js`, `scene.js`).
- **Distant horizon tree-line** — a jittered tree band around the course perimeter so the
  far horizon reads as a hazy distant forest edge (aerial fog supplies the atmospheric
  falloff) instead of bare turf meeting sky (`public/render/scene.js`, `config.horizonTrees`).

## [0.6.0] - 2026-06-15

### Fixed
- **GPU memory leaks on hole reload** — `loadCourse` now disposes `alphaMap`/`normalMap`/
  `roughnessMap`, the turf's shader-injected textures, and each foliage `customDepthMaterial`
  (previously only `.map` was freed, leaking foliage/turf textures every reload).
- **Per-frame trail material leak** — the shot tracer's `LineBasicMaterial` was reallocated
  every frame (~840 leaked objects/shot); it's now created once and reused.
- Stale per-course wind callbacks are reset on reload; hoisted a per-blade allocation out of
  the fescue build loop.

### Added
- **Deciduous tree variety** — added a broadleaf species (CC0 Jacaranda cluster atlas)
  with a rounded, feathery card canopy, mixed ~30% into the conifer stand for an
  Augusta-style mixed tree line. The tree builder is now species-parameterized
  (`public/render/tree-cards.js`).
- **Tree grounding** — soft contact-shadow decal blobs under each tree so they sit on
  the turf instead of looking pasted on. One instanced, unlit, depth-write-off,
  non-shadowing draped quad per tree (`public/render/grounding.js`, `config.grounding`).
  Chosen over GTAO, which can't run here (its normal pre-pass recompiles our custom
  `onBeforeCompile` materials and fails to compile).

## [0.5.0] - 2026-06-15

### Changed
- **Less uniform turf** — large-scale tonal variation (~50–120m patches) on the grass
  so fairway/rough reads as natural turf rather than a flat green carpet
  (`public/render/turf.js`).
- **Lush card-foliage conifers** — replaced the decimated film-model trees (which
  rendered as bare sticks — their 6.7M geometric needles collapse when decimated to an
  instanceable budget) with procedurally-built foliage cards: a tapered bark trunk plus
  a conical canopy of cross-fan cards textured with the fir's own needle-sprig atlas
  (`public/render/tree-cards.js`). Lush, photoreal, and ~800 tris/tree (vs ~80k),
  dropping the 17MB `conifer.glb` for three ~0.3–0.8MB textures.
- **Denser fescue** — rough grass now scatters in tight, bushy clumps (center-biased
  discs trimmed at the rough edge) instead of an even thin spread, with more blades
  per tuft and taller blades. Reads as real patchy fescue framing the holes rather
  than sparse isolated spikes (`public/render/scene.js`, `grass.js`, `config.js`).

## [0.4.0] - 2026-06-14

### Added
- **Animated water** — course water hazards now ripple and reflect the sky instead
  of sitting as a flat blue plane. An analytic wave field (golden-angle directions,
  non-harmonic frequencies) perturbs the surface normal in-shader to shimmer the HDRI
  reflection, with a Fresnel deep/shallow gradient and a sun-specular term — no texture
  asset, integrates with fog + post-FX (`public/render/water.js`). Gated by
  `config.water` (falls back to the static plane when off).

## [0.3.0] - 2026-06-14

Turf and atmosphere polish on top of the 0.2.0 renderer overhaul.

### Added
- **Bright sand bunkers** — tiled CC0 coast-sand texture (Poly Haven), brightened
  in-shader and mixed in on a dedicated bunker mask so bunkers read as light sand
  rather than flat tan (`public/render/turf.js`, `scene.js`).
- **Fescue / rough grass** — instanced geometry blades (green base → golden tip) with
  vertex-shader wind, clumped into tufts and scattered on the rough; the wispy long
  grass that frames a hole (`public/render/grass.js`).
- **Cinematic color grade** — a display-space grade pass after tone-mapping: gentle
  contrast + saturation, warm-highlight / cool-shadow split-tone, and a soft vignette
  (`public/render/postfx.js`).

### Notes
- Fescue lands as a foundation; density/LOD tuning is a later pass.
- Provenance for the new turf grass + sand textures added to `ASSETS.md`.

## [0.2.0] - 2026-06-14

Photoreal renderer overhaul — the course now reads as a real golf course under a
real sky instead of a flat low-poly scene.

### Added
- **Real sky** — bundled CC0 puresky HDRI for image-based lighting + a believable
  blue sky with clouds (`public/render/env.js`, `atmosphere.js`). Single sun source
  of truth drives the light + shadows.
- **Photoreal trees** — instanced, decimated CC0 pine model (Poly Haven fir,
  ~80k tris) with vertex-shader wind and alpha-cutout canopy shadows, replacing the
  low-poly icosahedron crowns (`public/render/trees.js`).
- **Real turf** — tiled CC0 PBR grass (albedo blade detail + normal + roughness) and
  shader-based mowing stripes gated to mown surfaces (`public/render/turf.js`).
- **Renderer config** — `public/render/config.js` feature flags + quality knobs
  (HDRI, fog, trees, turf, wind, tree cap/scale, GTAO scaffold).
- Node unit tests for the renderer's pure helpers (`test/`).

### Changed
- Replaced the procedural Preetham sky + band-aid exposure with HDRI-based lighting +
  aerial-perspective fog.
- Bundled CC0 art assets in `public/assets/` (offline) with provenance in `ASSETS.md`.

### Notes
- Ambient occlusion (GTAO) is scaffolded but disabled (`config.gtao`) pending a
  cleaner integration with the custom turf shader.
- See `docs/superpowers/specs/` and `docs/superpowers/plans/` for the design + tier plans.
