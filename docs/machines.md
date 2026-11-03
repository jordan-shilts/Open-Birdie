# Machines — where Open-Birdie is built, measured and played

Two computers work on this repo, and they are not the same class of hardware: a frame rate measured on
one says little about the other. Recorded 2026-11-02.

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
- **Nothing has been measured on the sim PC yet.** The 2026-06-14 photoreal spec targets "the sim PC's
  desktop GPU"; it has none. When a change claims a frame-rate win for the player, say which machine it was
  measured on, and measure on the sim PC before calling a budget met.

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
