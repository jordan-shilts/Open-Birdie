# Machines — where Open-Birdie is built, measured and played

Two computers work on this repo, and they are not the same class of hardware: a frame rate measured on
one says little about the other. Recorded 2026-11-02; sim PC frame times added 2026-11-03.

|  | Dev Mac | Sim PC |
|---|---|---|
| Role | Development; **every perf number in `CHANGELOG.md` so far** | **Runs the sim** — the desktop app the launch monitor connects to |
| Machine | Apple M3 Pro | Dell Latitude 5591 (laptop) |
| CPU | M3 Pro (core count not recorded) | Intel Core i7-8850H, 6 cores / 12 threads |
| Memory | not recorded | 24 GB |
| GPU | M3 Pro integrated (core count not recorded) | Intel UHD Graphics 630 (integrated) + NVIDIA GeForce MX130, 2 GB (switchable) |
| Display | measured at 1600x900, 1920x1143 and a 4K output | built-in panel, 1920x1080 @ 60 Hz |
| OS | macOS | Windows 11 Pro (25H2) |

## Which GPU renders the sim

**The Intel UHD Graphics 630, not the MX130.** Measured on the running desktop app: the Electron GPU
process held ~80% of the Intel adapter's 3D engine and nothing on the NVIDIA one. `main.js` passes no GPU
switch and Windows has no per-app graphics preference for the app, so Windows hands it the power-saving
adapter. The built-in panel is driven by the Intel GPU.

What follows from that:
- **Auto starts at Low on the sim PC.** `WEAK_GPU` in `public/render/quality.js` matches "Intel(R) UHD",
  so High has to be picked by hand there.
- **High tops out at 1080p on the sim PC, not 4K.** High renders up to native resolution, and the panel is
  1920x1080; dynamic resolution can step it down to half per axis (960x540) when frames run slow.
- **The sim PC has no desktop GPU.** The 2026-06-14 photoreal spec targets "the sim PC's desktop GPU"; it
  has none. When a change claims a frame-rate win for the player, say which machine it was measured on, and
  measure on the sim PC before calling a budget met (first numbers below).

## Measured on the sim PC

2026-11-03, on the newest build at the time (`feat/all-features` 1df4d85, which renders the same as `main`
c21e95a): full screen at 1920x1080 in Edge, the same Chromium engine as the desktop app, with the desktop
app idle (under 0.5% of the GPU). One 144 mph test drive from `/api/test-shot`, timed over the ball's
flight and roll; the High run was the second shot, from the fairway.

| Graphics | fps | median frame | p95 | worst | frames over 33 ms | canvas at the end |
|---|---|---|---|---|---|---|
| Auto (picks Low) | 39.7 | 16.8 ms | 33.5 ms | 66.9 ms | 160 | 768x432 |
| High | 20.1 | 50.0 ms | 83.2 ms | 166.5 ms | 144 | 967x544 |

- **GPU-bound at every setting.** The UHD 630's 3D engine sat at ~100% in both runs, and the desktop app on
  `main` holds it at ~100% while just standing on a tee.
- **Dynamic resolution is why High looks soft there.** It had reached its floor at Low (half of Low's
  1520x855) and nearly reached it at High (half of 1920x1080).
- **Same build on the dev Mac:** ~79–81 fps, p95 ~15.5 ms, at ~1080p internal (from `CHANGELOG.md`, not
  re-measured): about 4x the pixels at 2–4x the frame rate.

## Where a Low frame goes (dev Mac, 2026-11-04)

Measured on the dev Mac by throughput (frames drawn back to back, then a 1-pixel read-back so the GPU has
finished), in the sim PC's 1920x1080 window at device scale 1, Hazeltine's 1st tee at Low on `main` `ccae3e3`:
about 1.6 ms a frame that doesn't shrink with resolution plus 2.3 ms per million pixels. At the 768x432 the sim
PC had dropped to, that is ~2.4 ms, a tenth of the ~25 ms it took there; take ~10x as a rough guide from the dev
Mac to the sim PC on this scene, not a measurement. By part: trees ~0.9 ms (all vertex work, the same at any
resolution), the ground's turf shader ~0.9 ms per million pixels plus its triangles, bloom ~0.25 ms plus 0.35 ms
per million pixels, SMAA ~0.1 ms plus 0.4 ms per million pixels, the colour grade's own pass ~0.13 ms per million
pixels. Whistling Straits added a JavaScript-bound frame (2.5 ms a frame: a draw call per bunker) and ~1 M
triangles of rough tufts.

The changes this led to are in `CHANGELOG.md` ("Lighter frames for the sim PC's integrated GPU"); on the dev Mac
they take 17-35% off a Low frame. Still to do: measure them on the sim PC the same way as above. The GPU timer
queries (`EXT_disjoint_timer_query_webgl2`) gave per-pass times on the dev Mac that didn't add up (ANGLE on Metal),
so per-pass splits there came from switching parts off; on the sim PC (ANGLE on D3D11) the timers should work.

## Rendering on the MX130 instead

Windows Settings → System → Display → Graphics → add the app (`node_modules\electron\dist\electron.exe`
when run from source with `npm start`, or the installed `Open-Birdie.exe`) → **High performance**, then
restart the app. The MX130's renderer string doesn't match `WEAK_GPU`, so Auto would then start at High
and rely on the live downshift. Electron's `force_high_performance_gpu` switch is the in-app equivalent.
Not yet tested: whether the MX130 beats the UHD 630 on this workload once its frames are copied to the
Intel-driven panel — measure both before making either the default.

To see which GPU the app is on: Task Manager → Details → add the "GPU engine" column; `electron.exe`
(or `Open-Birdie.exe`) shows "GPU *n* - 3D", and the Performance tab names GPU *n*.

## Launch monitor

Open Connect listens on TCP 921 on every interface (`lib/openconnect.js`); point the monitor at the sim
PC's LAN address. Windows Firewall must allow the app on the profile the LAN is classified as — if Windows
calls the LAN "Public", a rule that allows only Private networks doesn't apply.

## Keeping this file safe to publish

This repo is public. Record hardware models and capabilities only — no IP addresses, hostnames, usernames
or home paths, network names, serial numbers or hardware UUIDs. To fill in the Mac's blanks, macOS
`system_profiler SPHardwareDataType SPDisplaysDataType` prints a serial number and hardware UUID too: copy
only the chip, core-count, memory and resolution lines.
