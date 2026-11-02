# ⛳ Open-Birdie

A golf course simulator built entirely on **open data and free infrastructure**, playable
with any launch monitor that speaks the **GSPro Open Connect** protocol — including the
**Uneekor EYEMINI LITE** via Uneekor VIEW + GSPconnect.

- **Real courses** from OpenStreetMap (fairways, greens, bunkers, water, trees, hole routings)
- **Real terrain** from AWS Terrain Tiles open elevation data — slopes affect flight, bounce, roll, and putts
- **Real physics** — drag + Magnus lift flight model from published aero fits (Ferguson, McNally &
  McPhee 2022), the same model as the OpenFlight launch monitor so carries match, spin-axis draws/fades, backspin zip-back on greens, gravity-fed breaks on slopes
- **Full round play** — 18 holes, scorecard with a round-complete summary, pick up to bail on a hole, water/OB penalties, gimmes, cup capture
- Desktop app (Electron) — no browser needed; a tablet/phone on the same network can mirror via the built-in web server (set `BIRDIE_HOST=0.0.0.0` to allow LAN access — localhost-only by default)

> **Independent open-source project — not affiliated with, endorsed by, or sponsored by
> Uneekor, GSPro, TrackMan, OpenStreetMap, or AWS.** All trademarks belong to their
> respective owners and are used nominatively for interoperability only. Provided **"AS IS",
> with no warranty and no liability** — see **[DISCLAIMER.md](DISCLAIMER.md)** and **[LICENSE](LICENSE)**.
> Golf is a physical activity that can cause injury or property/equipment damage; **use at your own risk.**

## Install

Download the latest **Open-Birdie-Setup-_x.y.z_.exe** from
[Releases](https://github.com/rroojrooj/Open-Birdie/releases) and run it. It installs
per-user (no admin prompt), adds Start Menu + desktop shortcuts, and launches when done.

Open-Birdie isn't code-signed yet, so the first run trips Windows SmartScreen
("Windows protected your PC"). Click **More info → Run anyway** — it's a one-time prompt.

## Launch

Double-click **Open-Birdie** on the Desktop, or from this folder:

```
npm start            # desktop app
npm run start:server # headless server only (view at http://localhost:8222)
```

## Connect your Uneekor EYEMINI LITE

1. **Close GSPro if it's running** — Open-Birdie listens on the same port (TCP 921).
   The console will say `Port 921 is in use` if there's a clash.
2. Start Open-Birdie.
3. In **Uneekor VIEW**, pick **GSPro** as the connected sim, exactly as you do today.
   GSPconnect will connect to `127.0.0.1:921` and find Open-Birdie answering.
4. The **LM badge** (top right) turns green when GSPconnect connects. Hit balls.

> **Using the free bridge (no GSPconnect)?** The desktop app auto-starts the bundled
> Uneekor VIEW feed bridge ([`tools/uneekor-watch.js`](tools/uneekor-watch.js)) whenever it
> finds your VIEW `ShotData` folder — the LM badge goes green by itself, just swing. No paid
> GSPconnect needed. Set `BIRDIE_NO_WATCH=1` to turn it off. (Headless `npm run start:server`
> users: run `npm run watch` alongside it.)

Everything runs on this PC; no firewall changes needed. (If GSPconnect ever runs on a
*different* PC, allow inbound TCP 921 in Windows Firewall.)

## Playing

| Control | Action |
| --- | --- |
| Mouse drag / wheel | look around / zoom (between shots) |
| AIM slider | rotate the aim line (shots are relative to it) |
| Club buttons | tells GSPconnect your club; also loads practice presets |
| Practice shot | hit simulated shots without the launch monitor |
| Course button | search and load any OSM-mapped course |
| Next ▶ / Pick up | advance to the next hole; pick up to concede a hole you aren't finishing |
| Hole pills / HOLE | tap a played hole to review it on the scorecard |
| Scorecard | scores, round-complete summary, restart / new round |
| Graphics | cycle Auto / High / Low (High: live pond mirrors, grass blades, full tree detail) |
| Sky | cycle Morning / Midday / Golden hour (sky photo + matching sun and haze) |
| Flyover / F | fly over the current hole, tee to green; any key or click skips back to the shot |
| F11 | toggle fullscreen |

Putts are detected automatically when on the green (low speed + low launch).
Anything stopped inside the gimme distance (8 ft default) is conceded for +1 stroke.
A ball rolled near the cup at holeable speed drops in.

## Courses

Search by name (e.g. *St Andrews Old Course*, *Pebble Beach Golf Links*). Quality depends on
OpenStreetMap mapping — famous courses are usually excellent. A course needs `golf=hole`
routing lines to be playable; the loader tells you if they're missing. First load downloads
geometry + elevation (10–90 s) and caches it in `data/courses/` — afterwards it's instant
and works offline.

Once a course is playable, its missing scenery follows in the background — real buildings and
the lakes and ponds around the course (OpenStreetMap), every real tree (canopy height map; needs
the optional `geotiff` package or the cloud service) and the course-wide aerial photo (USGS, US
only) — and appears on screen as each layer arrives. It is saved with the course, so this happens
once per course.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `BIRDIE_PORT` | 8222 | web UI / API port |
| `BIRDIE_OC_PORT` | 921 | GSPro Open Connect listener |
| `BIRDIE_HOST` | 127.0.0.1 | web UI/API bind address. Localhost-only by default (the API is unauthenticated); set `0.0.0.0` to mirror on your LAN — **trusted networks only** |
| `BIRDIE_SPEED_SCALE` | 1 | multiplier for incoming ball speed; set `2.23694` if your monitor reports m/s (shots play ~2.2× short otherwise) |
| `BIRDIE_NO_WATCH` | (unset) | set to `1` to skip auto-starting the Uneekor VIEW feed bridge |
| `BIRDIE_OVERPASS_URLS` | (unset) | comma-separated Overpass interpreter URLs to try before the built-in public mirrors (overpass-api.de, maps.mail.ru, kumi.systems, private.coffee) — useful when they are all at capacity or you run your own |
| `GOOGLE_MAPS_API_KEY` | (unset) | your own Google Map Tiles API key — turns on the optional Google 3D surroundings (below). Unset = no requests to Google at all |
| `BIRDIE_ENRICH` | 1 | set to `0` to stop fetching missing scenery (buildings, trees, aerial photo) in the background |
| `BIRDIE_CACHE_MAX_MB` | 1024 | size cap of the local course cache; the least recently played courses are deleted past it (never the one being played) and are downloaded again when picked. `0` = no cap |
| `BIRDIE_CLOUD_URL` | (unset) | base URL of an Open-Birdie cloud course service (see [Cloud courses](#cloud-courses)). Unset = everything is built on this computer and no cloud request is ever made |
| `BIRDIE_CLOUD_BUILD_TOKEN` | (unset) | lets this app ask the cloud to build a course it does not have yet (must match the service's token); without it, such courses are built locally |

Gimme distance: `POST /api/settings {"gimmeYd": feet}` (UI toggle coming later).

### Optional: Google 3D surroundings

With a key, the real houses, trees and lakes around the course stream in as Google
Photorealistic 3D Tiles. The course itself is still drawn from open data: inside the course's
terrain rectangle our own terrain, trees and buildings take over, and the Google tiles are
lifted or lowered to meet our terrain at the edge.

1. In a Google Cloud project with **billing enabled**, enable the **Map Tiles API** and create an
   API key (restrict it to the Map Tiles API). Each course load starts one tiles session (one
   root-tileset request); see Google's current Map Tiles pricing.
2. Start the app with the key in the environment, e.g. `GOOGLE_MAPS_API_KEY=... npm start`
   (Windows: `setx GOOGLE_MAPS_API_KEY "..."`, then reopen the terminal / restart the app).

The key is handed only to the local window (never to LAN mirrors) and is never logged or
cached. A rejected key logs one console warning and the game carries on without the tiles.
Attribution (the Google Maps logo, or the words "Google Maps", plus the data providers for the
tiles in view) shows at the bottom right, next to the course's own data credit. To use the
official logo, save Google's logo file as `public/assets/attribution/google-maps-logo.svg`.
Google's terms apply to everything streamed: no caching or exporting the tiles, and keep the
attribution visible. `?googleTiles=0` turns the tiles off for a page.

## Cloud courses

Point the app at an Open-Birdie cloud course service and courses are downloaded when you pick
them instead of being built on your computer, already complete with buildings, real trees and
the max-quality aerial photo:

```bash
BIRDIE_CLOUD_URL=https://<your-service> BIRDIE_CLOUD_BUILD_TOKEN=<token> npm start
```

- A course the cloud has is downloaded (every file checked against its sha256) into the local
  cache, which stays under `BIRDIE_CACHE_MAX_MB`.
- A course the cloud does not have yet is built there (needs the build token); the course picker
  shows the build's progress, the course is playable as soon as its base data is ready, and its
  scenery appears when the cloud has added it.
- If the cloud cannot be reached, the course is built on this computer as before.

### Running the cloud service

The service is [`cloud/server.js`](cloud/server.js) (Node ≥ 22). It builds each course once with
the same code as the desktop — OSM holes and buildings, USGS 3DEP lidar terrain, the NDVI
classmap — plus what the desktop app cannot ship: real trees from the canopy height map
(`geotiff`) and the max-quality tiled aerial (`sharp`). Each course becomes a package (manifest +
files with sha256) in object storage. It publishes a playable package as soon as the base data is
ready, then a complete one with the scenery. Its dependencies are in
[`cloud/package.json`](cloud/package.json); the image is [`cloud/Dockerfile`](cloud/Dockerfile)
(`node:22-slim`).

```bash
# local run, packages in ./cloud-store
BIRDIE_CLOUD_BUILD_TOKEN=dev-token node cloud/server.js
BIRDIE_CLOUD_URL=http://localhost:8080 BIRDIE_CLOUD_BUILD_TOKEN=dev-token npm start

# container (build context = repository root)
docker build -f cloud/Dockerfile -t open-birdie-cloud .
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` (or `BIRDIE_CLOUD_PORT`) | 8080 | listen port (Railway sets `PORT`) |
| `BIRDIE_CLOUD_BUILD_TOKEN` | (unset) | bearer token required by `POST /v1/courses`; unset = read-only service |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | | object storage (any S3-compatible store; SigV4-signed, no AWS SDK). Without `S3_BUCKET` packages go to a directory |
| `S3_FORCE_PATH_STYLE` | 0 | `1` for MinIO and older Railway buckets (an endpoint with a path, like Supabase's, is always path style) |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | endpoint used in presigned download URLs, when desktops must reach the store under another URL |
| `BIRDIE_CLOUD_STORE_DIR` | `./cloud-store` | directory store, when `S3_BUCKET` is unset |
| `BIRDIE_CLOUD_FILES` | `redirect` with S3, else `proxy` | serve files as 302s to presigned URLs, or stream them through the service |
| `BIRDIE_CLOUD_CONCURRENCY` | 1 | builds running at once (one build per course at a time regardless) |
| `BIRDIE_CLOUD_MAX_QUEUE` | 16 | builds waiting; beyond that `POST` answers 429 |
| `BIRDIE_DATA_DIR` | `<tmp>/birdie-cloud-staging` | scratch space for builds in progress |
| `BIRDIE_OVERPASS_URLS` | (unset) | Overpass mirrors to try first, as on the desktop |

API (JSON; `:key` is the course key, e.g. `osm-relation-9892305`):

| Request | Answer |
| --- | --- |
| `GET /v1/courses/:key` | `200` package manifest (`complete: false` while scenery is still being added) · `404` |
| `POST /v1/courses` with `Authorization: Bearer <token>`, body `{"source":{"osmType":"relation","osmId":9892305},"name":"…","bbox":[s,n,w,e]}` (`"force":true` rebuilds) | `200 {status:"ready", manifest}` · `202 {status, job}` · `401` · `429` queue full · `503` builds disabled |
| `GET /v1/jobs/:id` | `200 {status: queued\|running\|done\|failed, stage, message, pct, packageId, complete, error}` · `404` |
| `GET /v1/courses/:key/files/:sha256` | `302` to a presigned URL (S3) or `200` bytes |
| `GET /healthz` | `200 {ok, store, builds, files, queue}` |

### Deploying on Railway (service + bucket)

1. New project → deploy this GitHub repository as a service. In the service's variables set
   `RAILWAY_DOCKERFILE_PATH=cloud/Dockerfile` and `BIRDIE_CLOUD_BUILD_TOKEN` to a long random string.
2. Add a **Bucket** to the project (Create → Bucket). Give the service the bucket's credentials with
   reference variables (use your bucket's name in place of `Bucket`):
   ```
   S3_ENDPOINT=${{Bucket.ENDPOINT}}
   S3_BUCKET=${{Bucket.BUCKET}}
   S3_REGION=${{Bucket.REGION}}
   S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}
   S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}
   ```
   If the bucket's Credentials tab says to use path-style URLs, add `S3_FORCE_PATH_STYLE=1`.
3. Settings → Networking → generate a public domain, then check `https://<domain>/healthz`.
4. Point the desktop app at it: `BIRDIE_CLOUD_URL=https://<domain>` (plus `BIRDIE_CLOUD_BUILD_TOKEN`
   on machines allowed to start builds).

Railway buckets are private, so downloads go out as presigned redirects straight from the bucket
(bucket egress is free; proxying through the service would count as service egress).

Other providers work the same way: **Cloudflare R2** (`S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`,
`S3_REGION=auto`), **Supabase Storage** (`S3_ENDPOINT=https://<project>.supabase.co/storage/v1/s3`),
or **Coolify + MinIO** (`S3_FORCE_PATH_STYLE=1`, and `S3_PUBLIC_ENDPOINT` if MinIO's address inside
the server differs from its public one).

Limits: the job queue is in memory (a restart forgets running jobs; desktops ask again, and any
package already published survives), so run a single instance; files of superseded packages are
kept in the bucket (no clean-up yet).

## Dev tools

```
npm run calibrate                  # flight model vs tour TrackMan targets
node tools/test-shot.js driver     # fake GSPconnect shot over real TCP 921
node tools/test-shot.js --speed 150 --vla 13 --spin 2700 --axis -4
node tools/test-load.js "Course name"   # test course download/parse
```

The app adds buildings, trees and the aerial photo to every course by itself (see Courses).
These tools run the same code by hand — e.g. to refresh a course after OpenStreetMap edits, or
to get the max-quality tiled aerial (needs `sharp`). Run them in this order; each only adds
scenery and leaves the HD fingerprint alone, except refresh-elevation:

```bash
node tools/add-buildings.mjs      data/courses/<slug>.json   # OSM building footprints, clubhouse
node tools/add-course-aerial.mjs  data/courses/<slug>.json   # 0.3-0.6 m USGS aerial photo (US)
node tools/add-canopy-trees.mjs   data/courses/<slug>.json   # every real tree, with height and crown
node tools/refresh-elevation.mjs  data/courses/<slug>.json   # re-fetch lidar if a load fell back
```

## Open data credits

- Course geometry © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  via [Overpass API](https://overpass-api.de/) and [Nominatim](https://nominatim.org/)
- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium) and
  [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) lidar (public domain)
- Aerial imagery: [USGS NAIP / NAIPPlus](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-aerial-photography-national-agriculture-imagery-program-naip) (public domain)
- Tree positions and heights: Meta and World Resources Institute (WRI),
  [High Resolution Canopy Height Maps](https://registry.opendata.aws/dataforgood-fb-forests/),
  licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (`lib/canopy-fetch.js`)
- Skies, leaves, needles and bark: [Poly Haven](https://polyhaven.com) (CC0) — see `ASSETS.md`
- Optional surroundings (only with your own key): Google Photorealistic 3D Tiles, streamed under
  the [Google Maps Platform terms](https://cloud.google.com/maps-platform/terms), rendered with
  [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) (Apache-2.0)

## Known limitations / roadmap

- Visuals are "good indie sim" tier, not premium-sim grade: flat-shaded splat terrain, low-poly trees.
  Next: grass textures, normal maps, better tree models, bunker depth.
- The flight model is fit to measured shots, not tuned to PGA Tour averages: vs those, carries sit
  within ~5% (driver 279 vs 275 yd, 7-iron 163 vs 172) and apex within ~5 ft (`npm run calibrate`).
- Pin positions come from OSM hole lines (one per green; double greens use the mapped point).
- No wind UI yet (the physics supports it).

## License & disclaimer

Open-Birdie is free and open-source software under the **[MIT License](LICENSE)**.

It is an **independent project, not affiliated with, authorized by, or endorsed by** Uneekor,
GSPro, TrackMan, the OpenStreetMap Foundation, AWS, or any other referenced party. The Software
implements the publicly documented GSPro Open Connect interface for interoperability and contains
no third-party proprietary code or assets. All product names and trademarks are the property of
their respective owners and are used solely nominatively.

The Software is provided **"AS IS", without warranty of any kind**, and the authors accept
**no liability** for any damages, personal injury, or damage to equipment or property arising
from its use. **You** are responsible for your own safety and for complying with the terms of
service / EULAs of your launch monitor, its first-party software, and every third-party data
source the app contacts (OpenStreetMap/ODbL, Overpass, Nominatim, AWS Terrain Tiles, USGS,
Meta/WRI canopy data).

Read the full terms in **[DISCLAIMER.md](DISCLAIMER.md)**
