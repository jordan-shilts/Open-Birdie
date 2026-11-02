// Hole flyover: a broadcast-style camera flight over the current hole. It dips to black,
// starts low behind the tee, rises to ~40-60 m, travels down the hole line looking ahead,
// descends toward the green, then dips to black and cuts back to the address view.
//
// The path maths (centripetal Catmull-Rom, arc-length reparametrisation, eased progress)
// is pure — no three, no DOM — and unit-tested (test/flyover.test.mjs). HoleFlyover drives
// GolfScene's camera while scene.camMode === 'flyover' (a non-play framing, so the aim
// line and the distance-inflated ball/pin stay off — see framing.js).
//
// Sim coordinates throughout: x east, y north, z up (metres); three = (x, z, -y).

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export const FLYOVER_DEFAULTS = Object.freeze({
  startBackM: 32,       // start this far behind the tee ...
  startAglM: 12,        // ... this high above the ground
  minCruiseAglM: 40,    // cruise height grows with hole length within [min, max]
  maxCruiseAglM: 60,
  endBackM: 42,         // finish this far short of the pin ...
  endAglM: 18,          // ... this high, looking down at the flag
  riseFrac: 0.3,        // share of the flight spent climbing to cruise height
  descendFrac: 0.35,    // ... and descending toward the green
  lookAheadM: 110,      // look target this far down the hole line (≈ 24° down at cruise)
  lookAglM: 1.5,        // look target height above the ground
  minClearM: 9,         // never closer than this to the terrain anywhere on the path
  keySpacingM: 45,      // camera keyframe spacing along the hole
});

// Flight time grows with hole length: 8 s up to a 150 m par 3, 14 s from a 550 m par 5.
export function flyoverDuration(lengthM) {
  return clamp(5.75 + 0.015 * (Number(lengthM) || 0), 8, 14);
}

// Eased progress with a constant-speed cruise: velocity ramps up over the first `accel`
// share of the time and down over the last `decel` share along raised-cosine curves, so
// the camera starts and stops at rest with no jerk at either end. s(0) = 0, s(1) = 1.
export function easeCruise(t, accel = 0.2, decel = 0.25) {
  const a = clamp(accel, 1e-6, 0.5), b = clamp(decel, 1e-6, 0.5);
  t = clamp(t, 0, 1);
  const area = 1 - (a + b) / 2; // integral of the un-normalised velocity profile
  let s;
  if (t < a) s = t / 2 - (a / (2 * Math.PI)) * Math.sin((Math.PI * t) / a);
  else if (t <= 1 - b) s = a / 2 + (t - a);
  else {
    const u = t - (1 - b);
    s = a / 2 + (1 - a - b) + u / 2 + (b / (2 * Math.PI)) * Math.sin((Math.PI * u) / b);
  }
  return clamp(s / area, 0, 1);
}

// Drop consecutive points closer than `minM` (zero-length spans break the knot spacing).
export function dedupePoints(pts, minM = 0.5, spaceDims = 2) {
  const out = [];
  for (const p of pts || []) {
    if (!p || p.length < spaceDims || !p.slice(0, spaceDims).every(Number.isFinite)) continue;
    const q = out[out.length - 1];
    if (q && dist(p, q, spaceDims) < minM) continue;
    out.push(p.slice());
  }
  return out;
}

function dist(a, b, dims) {
  let s = 0;
  for (let k = 0; k < dims; k++) s += (b[k] - a[k]) ** 2;
  return Math.sqrt(s);
}

// Centripetal Catmull-Rom (alpha 0.5) through `pts` — arrays of numbers whose first
// `spaceDims` components set the knot spacing; any further components (e.g. the
// along-hole distance) are interpolated alongside. Centripetal spacing never cusps or
// self-intersects on unevenly spaced keys. The ends are extended by reflection, so the
// curve starts on the first point and ends exactly on the last. Returns a dense polyline.
export function catmullRomChain(pts, { perSeg = 24, alpha = 0.5, spaceDims = 3 } = {}) {
  if (!pts || pts.length < 2) return (pts || []).map((p) => p.slice());
  const n = pts.length, dim = pts[0].length;
  const reflect = (a, b) => b.map((v, k) => 2 * v - a[k]);
  const ext = [reflect(pts[1], pts[0]), ...pts, reflect(pts[n - 2], pts[n - 1])];
  const knot = (a, b) => Math.max(1e-4, Math.pow(dist(a, b, spaceDims), alpha));
  const out = [];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let s = 0; s < perSeg; s++) {
      const t = t1 + ((t2 - t1) * s) / perSeg;
      const q = new Array(dim);
      for (let k = 0; k < dim; k++) {
        // Barry-Goldman pyramid
        const a1 = ((t1 - t) * p0[k] + (t - t0) * p1[k]) / (t1 - t0);
        const a2 = ((t2 - t) * p1[k] + (t - t1) * p2[k]) / (t2 - t1);
        const a3 = ((t3 - t) * p2[k] + (t - t2) * p3[k]) / (t3 - t2);
        const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
        const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
        q[k] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
      }
      out.push(q);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

// Cumulative arc length of a polyline (first `spaceDims` components).
export function arcLengthTable(pts, spaceDims = 3) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + dist(pts[i - 1], pts[i], spaceDims);
  return { pts, s, total: pts.length ? s[pts.length - 1] : 0 };
}

// Point at arc length `len` along the table (clamped to the ends), all components lerped.
export function sampleAtLength(table, len) {
  const { pts, s, total } = table;
  if (pts.length === 1 || len <= 0) return pts[0].slice();
  if (len >= total) return pts[pts.length - 1].slice();
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= len) lo = mid; else hi = mid;
  }
  const f = (len - s[lo]) / Math.max(1e-9, s[hi] - s[lo]);
  return pts[lo].map((v, k) => lerp(v, pts[hi][k], f));
}

// The hole line as a smooth curve: dense polyline, its length, and at(d) — the point
// d metres along it, extrapolated straight past the tee (d < 0) and the pin (d > length).
export function holePath(line) {
  const pts = dedupePoints((line || []).map((p) => [Number(p[0]), Number(p[1])]), 0.5, 2);
  if (pts.length < 2) return null;
  const dense = pts.length === 2 ? pts : catmullRomChain(pts, { perSeg: 32, spaceDims: 2 });
  const table = arcLengthTable(dense, 2);
  if (!(table.total > 1)) return null;
  const dir = (a, b) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
  const first = dense[0], last = dense[dense.length - 1];
  const d0 = dir(first, dense[1]), d1 = dir(dense[dense.length - 2], last);
  return {
    length: table.total,
    at(d) {
      if (d <= 0) return [first[0] + d0[0] * d, first[1] + d0[1] * d];
      if (d >= table.total) { const e = d - table.total; return [last[0] + d1[0] * e, last[1] + d1[1] * e]; }
      return sampleAtLength(table, d);
    },
  };
}

// The flown line for the active hole: the course hole whose tee/pin match it (the OSM
// routing line, doglegs included) with its ends pinned to the actual tee and pin, else a
// straight tee -> pin line. activeHole: { tee: [x,y], pin: [x,y] } (GolfScene._activeHole).
export function flyoverLineForHole(holes, activeHole) {
  const tee = activeHole?.tee, pin = activeHole?.pin;
  if (!tee || !pin || !tee.every(Number.isFinite) || !pin.every(Number.isFinite)) return null;
  let best = null, bestD = 40; // metres, tee + pin mismatch summed
  for (const h of holes || []) {
    if (!h?.tee || !h?.pin) continue;
    const d = Math.hypot(h.tee[0] - tee[0], h.tee[1] - tee[1]) + Math.hypot(h.pin[0] - pin[0], h.pin[1] - pin[1]);
    if (d < bestD) { bestD = d; best = h; }
  }
  const line = best && Array.isArray(best.line) && best.line.length >= 2 ? best.line.slice(1, -1) : [];
  return [tee.slice(), ...line.map((p) => p.slice()), pin.slice()];
}

// Build the flight for a hole line. groundAt(x,y) -> terrain height; treeTopAt(x,y) -> the
// height a camera must stay above for the trees there (treeCeiling), optional. Returns null
// for a degenerate line. The camera spline carries [x, y, z, along-hole distance].
export function buildFlyoverPath({ line, groundAt = () => 0, treeTopAt = null, ...options } = {}) {
  const o = { ...FLYOVER_DEFAULTS, ...options };
  const hole = holePath(line);
  if (!hole) return null;
  const L = hole.length;
  const g = (x, y) => { const h = groundAt(x, y); return Number.isFinite(h) ? h : 0; };
  const cruise = clamp(30 + 0.04 * L, o.minCruiseAglM, o.maxCruiseAglM);
  const startD = -o.startBackM;
  const endD = Math.max(L * 0.5, L - o.endBackM);
  const span = endD - startD;
  const agl = (d) => {
    const f = (d - startD) / span;
    const up = smoothstep(0, o.riseFrac, f), down = smoothstep(1 - o.descendFrac, 1, f);
    return lerp(lerp(o.startAglM, cruise, up), o.endAglM, down);
  };
  // highest ground near a key (±15 m along the hole) so a crest between keys can't clip
  const groundNear = (d) => Math.max(...[-15, 0, 15].map((k) => { const [x, y] = hole.at(d + k); return g(x, y); }));

  const n = clamp(Math.round(span / o.keySpacingM), 5, 16);
  const keys = [];
  for (let i = 0; i <= n; i++) {
    const d = startD + (span * i) / n;
    const [x, y] = hole.at(d);
    keys.push([x, y, groundNear(d) + agl(d), d]);
  }
  const dense = catmullRomChain(keys, { perSeg: 40, spaceDims: 3 });
  // Tree crowns: lift the path over any it would clip, as a smooth bump (dilate the needed
  // lift ±25 samples, then box-average ±12, so it still clears where it must) — not a kink.
  if (treeTopAt) {
    const need = dense.map((p) => Math.max(0, treeTopAt(p[0], p[1]) - p[2]));
    if (need.some((v) => v > 0)) {
      const lift = boxFilter(maxFilter(need, 25), 12);
      dense.forEach((p, i) => { p[2] += lift[i]; });
    }
  }
  for (const p of dense) p[2] = Math.max(p[2], g(p[0], p[1]) + o.minClearM); // terrain safety net
  const cam = arcLengthTable(dense, 3);

  // Look target down the hole line, converging smoothly on the pin as the camera nears
  // the green (a hard clamp at the pin would jerk the view).
  const targetD = (dCam) => lerp(dCam + o.lookAheadM, L, smoothstep(endD - 1.5 * o.lookAheadM, endD, dCam));
  const look = dense.map((p) => {
    const [x, y] = hole.at(targetD(p[3]));
    return [x, y, g(x, y) + o.lookAglM];
  });
  // The target rides the ground: low-pass its height (~±13 m, two box passes) so a bunker
  // lip or a steep bank under it can't twitch the view.
  const lookZ = boxFilter(boxFilter(look.map((p) => p[2]), 12), 12);
  look.forEach((p, i) => { p[2] = lookZ[i]; });
  return { duration: flyoverDuration(L), holeLength: L, cruiseAgl: cruise, cam, look };
}

// Sliding-window max / mean over an array (window clipped at the ends).
function maxFilter(v, r) {
  return v.map((_, i) => { let m = -Infinity; for (let k = Math.max(0, i - r); k <= Math.min(v.length - 1, i + r); k++) m = Math.max(m, v[k]); return m; });
}
function boxFilter(v, r) {
  return v.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - r); k <= Math.min(v.length - 1, i + r); k++) { s += v[k]; n++; } return s / n; });
}

// Camera pose at time t (seconds, clamped to the flight): { pos: [x,y,z], look: [x,y,z] }.
export function flyoverPoseAt(path, t) {
  const u = easeCruise(clamp(t / path.duration, 0, 1));
  const { pts, s, total } = path.cam;
  const len = u * total;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= len) lo = mid; else hi = mid;
  }
  const f = hi > lo ? clamp((len - s[lo]) / Math.max(1e-9, s[hi] - s[lo]), 0, 1) : 0;
  const a = pts[lo], b = pts[hi], la = path.look[lo], lb = path.look[hi];
  return {
    pos: [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)],
    look: [lerp(la[0], lb[0], f), lerp(la[1], lb[1], f), lerp(la[2], lb[2], f)],
  };
}

// The same pose as GolfScene's free-camera parameters ({tx, ty, h, hOff, yaw, pitch, dist};
// see _freeTargets / _freeStep). Lets capture tooling render exact flyover frames through
// the existing visual-capture 'free' mode. groundAt matches scene.hAt.
export function freeCamPose(pos, look, groundAt = () => 0) {
  const dx = look[0] - pos[0], dy = look[1] - pos[1], dz = look[2] - pos[2];
  const horiz = Math.hypot(dx, dy), dist3 = Math.hypot(horiz, dz) || 1e-6;
  return {
    tx: look[0], ty: look[1], h: look[2],
    hOff: look[2] - groundAt(look[0], look[1]) - 2, // _freeStep re-derives h = ground + 2 + hOff
    yaw: (Math.atan2(dx, dy) * 180) / Math.PI,
    pitch: (Math.asin(clamp(dz / dist3, -1, 1)) * 180) / Math.PI,
    dist: dist3,
  };
}

// treeTopAt(x, y) for buildFlyoverPath: the height the camera must stay above at (x, y) —
// the highest crown (radius + marginM around it) plus marginM — or -Infinity in the open.
// Trees are scene tree spots ({x, y, h?, r?, s?}); hashed on a grid so the whole dense
// path can be checked against thousands of trees.
export function treeCeiling(trees, groundAt, { marginM = 3, cellM = 20 } = {}) {
  if (!trees || !trees.length) return null;
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  let maxR = 0;
  for (const t of trees) {
    if (!Number.isFinite(t?.x) || !Number.isFinite(t?.y)) continue;
    const r = (t.r || 5 * (t.s || 1)) + marginM;
    const top = groundAt(t.x, t.y) + (t.h || 14 * (t.s || 1)) + marginM;
    maxR = Math.max(maxR, r);
    const k = key(Math.floor(t.x / cellM), Math.floor(t.y / cellM));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ x: t.x, y: t.y, r, top });
  }
  const reach = Math.ceil(maxR / cellM);
  return (x, y) => {
    const ci = Math.floor(x / cellM), cj = Math.floor(y / cellM);
    let top = -Infinity;
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        for (const t of grid.get(key(i, j)) || []) {
          if (t.top > top && (t.x - x) ** 2 + (t.y - y) ** 2 < t.r * t.r) top = t.top;
        }
      }
    }
    return top;
  };
}

// ---------------------------------------------------------------------------
// Runtime controller. Phases: enter (dip to black from the current view) -> fly ->
// hold (a beat on the green) -> exit (dip to black) -> back (address view fades in).
// Any key or click skips to exit. If anything else takes the camera (a shot replay,
// a new hole, free look), the flyover just cleans up.

const FADE_TO_BLACK_S = 0.28;
const FADE_FROM_BLACK_S = 0.45;
const HOLD_S = 0.6;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

export class HoleFlyover {
  constructor(scene) {
    this.scene = scene;
    this.state = null;
    this._fadeEl = null;
    this._hintEl = null;
    this._onInput = (e) => this._skipFromInput(e);
  }

  get active() { return !!this.state; }

  // Start the flyover of the current hole. Returns false when it can't run now (no course
  // or hole yet, a shot replay is playing or settling, or a flyover is already running).
  start() {
    const sc = this.scene;
    if (this.state || !sc.geo || sc.anim || sc.camMode === 'static' || !sc._activeHole) return false;
    const line = flyoverLineForHole(sc.geo.holes, sc._activeHole);
    const groundAt = (x, y) => sc.hAt(x, y);
    const path = line && buildFlyoverPath({ line, groundAt, treeTopAt: treeCeiling(sc._allTreeSpots || sc._placedTrees, groundAt) });
    if (!path) return false;
    if (sc.camMode === 'free') sc.enterFreeCam(false); // let the free-look UI reset first
    sc.camMode = 'flyover';
    sc.camPosT.copy(sc.camera.position); // hold the current view while dipping to black
    sc.lookT.copy(sc.lookCur);
    this.state = { phase: 'enter', t: 0, fade: 0, fadeFrom: 0, path, holeRef: sc._activeHole.ref };
    this._mount();
    this._listen(true);
    return true;
  }

  // Cut short: dip to black and return to the address view.
  skip() {
    const st = this.state;
    if (!st || st.phase === 'exit' || st.phase === 'back') return;
    st.phase = 'exit'; st.t = 0; st.fadeFrom = st.fade;
  }

  // Per-frame (GolfScene._frame, after the camera-mode targets, before the camera eases).
  update(dt) {
    const st = this.state;
    if (!st) return;
    const sc = this.scene;
    if (sc.camMode !== 'flyover' && st.phase !== 'back') { this._teardown(); return; }
    // Follow the wall clock: the scene clamps dt at 20 fps, which would stretch the flight
    // on a slow GPU. A stall still advances at most 0.1 s in one frame.
    const now = typeof performance !== 'undefined' ? performance.now() : null;
    st.t += now != null && st.clock != null ? Math.min(0.1, Math.max(0, (now - st.clock) / 1000)) : dt;
    st.clock = now;
    switch (st.phase) {
      case 'enter':
        st.fade = Math.min(1, st.t / FADE_TO_BLACK_S);
        if (st.t >= FADE_TO_BLACK_S) { st.phase = 'fly'; st.t = 0; this._applyPose(flyoverPoseAt(st.path, 0)); }
        break;
      case 'fly':
        this._applyPose(flyoverPoseAt(st.path, st.t));
        st.fade = 1 - Math.min(1, st.t / FADE_FROM_BLACK_S);
        if (st.t >= st.path.duration) { st.phase = 'hold'; st.t = 0; }
        break;
      case 'hold':
        st.fade = 0;
        if (st.t >= HOLD_S) { st.phase = 'exit'; st.t = 0; st.fadeFrom = 0; }
        break;
      case 'exit':
        st.fade = lerp(st.fadeFrom, 1, Math.min(1, st.t / FADE_TO_BLACK_S));
        if (st.t >= FADE_TO_BLACK_S) {
          sc.camMode = 'idle';
          sc._snapIdleCam();
          this._listen(false);
          if (this._hintEl) this._hintEl.style.display = 'none';
          if (sc.markerLayer) sc.markerLayer.style.visibility = '';
          st.phase = 'back'; st.t = 0;
        }
        break;
      case 'back':
        st.fade = 1 - Math.min(1, st.t / FADE_FROM_BLACK_S);
        if (st.t >= FADE_FROM_BLACK_S) { this._teardown(); return; }
        break;
      default:
        break;
    }
    if (this._fadeEl) this._fadeEl.style.opacity = st.fade.toFixed(3);
  }

  _applyPose(pose) {
    const sc = this.scene;
    sc.camPosT.set(pose.pos[0], pose.pos[2], -pose.pos[1]);
    sc.lookT.set(pose.look[0], pose.look[2], -pose.look[1]);
    // the flight is already smooth: place the camera exactly (the frame's ease is a no-op)
    sc.camera.position.copy(sc.camPosT);
    sc.lookCur.copy(sc.lookT);
  }

  _skipFromInput(e) {
    const st = this.state;
    if (!st || st.phase === 'exit' || st.phase === 'back') return;
    if (e.type === 'keydown' && (e.repeat || MODIFIER_KEYS.has(e.key))) return;
    this.skip();
    // the skip consumes the key/click (no free-cam toggle, no orbit drag) unless typing
    if (!(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) {
      e.stopPropagation();
      if (e.type === 'keydown') e.preventDefault();
    }
  }

  _listen(on) {
    if (typeof window === 'undefined') return;
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('keydown', this._onInput, true);
    window[m]('pointerdown', this._onInput, true);
  }

  _mount() {
    const sc = this.scene;
    if (typeof document === 'undefined' || !sc.container) return;
    if (!this._fadeEl) {
      this._fadeEl = Object.assign(document.createElement('div'), { className: 'flyover-fade' });
      this._hintEl = Object.assign(document.createElement('div'), { className: 'flyover-hint' });
      sc.container.append(this._fadeEl, this._hintEl);
    }
    this._fadeEl.style.opacity = '0';
    this._fadeEl.style.display = '';
    const ref = this.state?.holeRef;
    this._hintEl.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: 'Flyover' }),
      `${ref != null ? ` · hole ${ref}` : ''} · any key or click to skip`,
    );
    this._hintEl.style.display = '';
    if (sc.markerLayer) sc.markerLayer.style.visibility = 'hidden'; // yardage pills belong to the address view
  }

  _teardown() {
    this._listen(false);
    this.state = null;
    if (this._fadeEl) { this._fadeEl.style.opacity = '0'; this._fadeEl.style.display = 'none'; }
    if (this._hintEl) this._hintEl.style.display = 'none';
    if (this.scene.markerLayer) this.scene.markerLayer.style.visibility = '';
  }

  // Drop any running flyover without touching the camera (e.g. on teardown).
  dispose() { this._teardown(); }
}
