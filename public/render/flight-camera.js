// Shot-replay camera: broadcast-style coverage of the flight in one continuous move (no
// cuts), framed so the ball's height reads. Pure (sim coordinates, no three) so the
// framing is unit-tested (test/flight-camera.test.mjs).
//
// Off the wide address lens a 20 m apex 120 m out is ~6° of a 58° frame, and a camera
// that pitches to keep the ball centred hides even that: the flight reads flat. So:
//  - Launch and climb: the camera holds the address vantage (no cut at impact) and the
//    lens closes in as the ball leaves, telephoto, the way a broadcast camera behind the
//    tee follows a drive; the ball rides up through the upper half of the frame over a
//    horizon that stays in view.
//  - Descent: the camera glides, low and under the flight, to a vantage beside and a
//    little short of the landing area, so the ball drops out of the sky across the frame
//    and the bounce and roll-out happen in view; the lens closes in on the drop.
// Short shots (chips, putts) never move the camera or the lens.
import { flightMarkers, pointAt } from './flight-profile.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, f) => a + (b - a) * f;
const D2R = Math.PI / 180;

export const CAM_CLEARANCE_M = 2.0;   // never closer than this above the ground
export const DROP_ZOOM = 1.8;         // lens magnification at touchdown (wide = 1)
export const MAX_CLIMB_ZOOM = 3.2;    // the tightest the lens closes on the climb
const ZOOM_REF_M = 34;                // the climb's lens: the ball's distance at glide start / this
const CLIMB_FRAME = 0.32;             // through the climb the ball rides this far above the frame's middle (share of half-height)
const LEASH = 0.62;                   // ...and never strays further than this from the middle, whatever the framing
const GLIDE_SAMPLES = 64;             // the glide's tree-clearance profile
const TREE_CLIMB_DEG = 25;            // the steepest the glide climbs to clear a tree line

// points: sim trajectory; startCam / startLook: the address camera and its look target
// now (sim frame); groundAt(x,y) -> terrain height; treeTopAt(x,y) -> the height the
// camera must stay above there (-Infinity in the open; flyover.js treeCeiling);
// flightTime: s at first ground contact; isClear(x,y) -> false where the landing vantage
// would sit in a tree or look through one; fovDeg: the base (unzoomed) vertical lens.
export function flightCameraPlan(points, {
  startCam, startLook = null, groundAt = () => 0, treeTopAt = null, flightTime = null,
  isPutt = false, isClear = () => true, fovDeg = 58,
} = {}) {
  const p0 = points[0];
  const last = points[points.length - 1];
  const { apex, landing } = flightMarkers(points, flightTime);
  const land = landing || last;
  const carry = Math.hypot(land.x - p0.x, land.y - p0.y);
  const ft = Number.isFinite(flightTime) && flightTime > 0 ? flightTime : land.t;
  const start = startCam ? { ...startCam } : { x: p0.x, y: p0.y - 12, z: p0.z + 5 };
  const moves = !isPutt && carry >= 45;
  const apexH = apex ? Math.max(0, apex.z - Math.max(p0.z, land.z)) : 0;
  const arc = moves ? clamp(apexH * 0.2, 1, 5) : 0;
  let end = { ...start };
  if (moves) {
    // unit vector tee -> landing and its right-hand normal
    const ux = (land.x - p0.x) / carry, uy = (land.y - p0.y) / carry;
    const rx = uy, ry = -ux;
    // sit on the side the ball curves AWAY from, so the descent isn't hidden behind
    // the camera's own line of sight (offline sign: + = right of the launch line)
    const off = (last.x - p0.x) * rx + (last.y - p0.y) * ry;
    const side = off > 0 ? -1 : 1;
    // beside the landing area and a little short of it, low: the ball comes down from
    // above the camera, against the sky, instead of skimming the grass below it
    const back = clamp(carry * 0.1, 8, 26);
    const lateral = clamp(carry * 0.16, 12, 30);
    const lift = clamp(apexH * 0.3, 3, 8);
    // preferred vantage first, then the other side, then further back and nearer the line;
    // the first one in the open with a glide that clears the trees on the way wins (on a
    // tree-lined hole, the one whose glide has to climb least: a camera lifted over a
    // tree line looks down on the flight again)
    const candidates = [
      [back, lateral * side], [back, -lateral * side],
      [back * 1.8, lateral * side * 0.6], [back * 1.8, -lateral * side * 0.6],
      [back * 2.6, lateral * side * 0.3], [back * 2.6, -lateral * side * 0.3], [back * 3, 0],
    ];
    const at = (c) => {
      const x = land.x - ux * c[0] + rx * c[1], y = land.y - uy * c[0] + ry * c[1];
      return { x, y, z: Math.max(groundAt(x, y), land.z) + lift };
    };
    let best = null;
    for (const c of candidates) {
      const e = at(c);
      if (!isClear(e.x, e.y)) continue;
      const need = glideTreeNeed(treeTopAt, start, e, arc);
      if (!best || need < best.need - 0.5) best = { e, need };
      if (need <= 0.5) break;
    }
    end = best ? best.e : at(candidates[0]);
  }
  const plan = {
    p0, apex, land, last, carry, flightTime: ft, start, end, moves, apexH,
    apexT: apex ? apex.t : ft * 0.5,
    glideStart: ft * 0.3, glideEnd: ft * 0.9,
    arc,
    lift: null,
    groundAt,
    halfFov: (fovDeg / 2) * D2R,
    startLook: startLook ? { ...startLook } : null,
    climbZoomMax: 1, climbZoom: 1,
  };
  if (moves) {
    // The lens closes in through the climb, but not so far that the horizon leaves the
    // frame under a high ball (a wedge's apex sits steep above the camera).
    const eApex = apex ? Math.atan2(apex.z - start.z, Math.hypot(apex.x - start.x, apex.y - start.y)) : 0;
    plan.climbZoomMax = clamp((Math.tan(plan.halfFov) * 1.1) / Math.tan(Math.max(eApex, 0) + 2 * D2R), 1, MAX_CLIMB_ZOOM);
    const g = pointAt(points, plan.glideStart) || land;
    plan.climbZoom = clamp(Math.hypot(g.x - start.x, g.y - start.y) / ZOOM_REF_M, 1, plan.climbZoomMax);
    // Glide over tree crowns it can't avoid: a ramp up to each (no steeper than
    // TREE_CLIMB_DEG), rounded off (dilate, then average: each sample still clears its
    // neighbours, and a little headroom covers the path between samples), so the low
    // path never flies through a canopy nor shoots up at one. The lift fades in from the
    // start: the camera leaves from wherever the address camera is (trees round a tee
    // must not jolt it skyward at impact).
    if (treeTopAt) {
      const need = [];
      for (let i = 0; i <= GLIDE_SAMPLES; i++) {
        const p = glidePos(plan, i / GLIDE_SAMPLES, 0);
        need.push(Math.max(0, treeTopAt(p.x, p.y) - p.z + 0.3));
      }
      if (need.some((v) => v > 0)) {
        const k = (Math.tan(TREE_CLIMB_DEG * D2R) * Math.hypot(end.x - start.x, end.y - start.y)) / GLIDE_SAMPLES;
        const ramp = need.map((_, i) => Math.max(...need.map((v, j) => v - k * Math.abs(i - j))));
        plan.lift = boxFilter(maxFilter(ramp, 4), 3).map((v, i) => v * smooth(0, 0.2, i / GLIDE_SAMPLES));
      }
    }
  }
  return plan;
}

// How far the straight glide start -> end would pass under tree crowns at worst (m; 0 =
// clear), past its first stretch (the camera starts where the address camera already is).
function glideTreeNeed(treeTopAt, start, end, arc) {
  if (!treeTopAt) return 0;
  let worst = 0;
  for (let i = 4; i <= 24; i++) {
    const u = i / 24;
    const z = lerp(start.z, end.z, u) + Math.sin(Math.PI * u) * arc;
    worst = Math.max(worst, treeTopAt(lerp(start.x, end.x, u), lerp(start.y, end.y, u)) - z);
  }
  return worst;
}

// Camera position along the glide at progress u (0 = address vantage, 1 = landing vantage).
function glidePos(plan, u, treeLift = liftAt(plan, u)) {
  const x = lerp(plan.start.x, plan.end.x, u);
  const y = lerp(plan.start.y, plan.end.y, u);
  let z = lerp(plan.start.z, plan.end.z, u) + Math.sin(Math.PI * u) * plan.arc + treeLift;
  z = Math.max(z, plan.groundAt(x, y) + CAM_CLEARANCE_M);
  return { x, y, z };
}
function liftAt(plan, u) {
  if (!plan.lift) return 0;
  const f = clamp(u, 0, 1) * GLIDE_SAMPLES, i = Math.min(GLIDE_SAMPLES - 1, Math.floor(f));
  return lerp(plan.lift[i], plan.lift[i + 1], f - i);
}

// Camera position + look target + lens zoom at sim time t.
export function flightCameraAt(plan, t, points) {
  const u = plan.moves ? smooth(plan.glideStart, plan.glideEnd, t) : 0;
  const pos = glidePos(plan, u);
  const ball = pointAt(points, t) || plan.last;
  const air = t < plan.flightTime;
  // Descent framing: look slightly AHEAD of the ball toward the landing spot while it's
  // in the air so the drop zone enters frame before the ball does; settle on the ball
  // once down. The lead shrinks on the drop, so a zoomed frame keeps the ball near centre.
  const drop = plan.moves ? smooth(plan.apexT, plan.flightTime, t) : 0;
  const lead = air ? 0.22 * smooth(0, plan.flightTime * 0.5, t) * (1 - 0.5 * drop) : 0;
  const dropLook = {
    x: lerp(ball.x, plan.land.x, lead),
    y: lerp(ball.y, plan.land.y, lead),
    z: lerp(ball.z, plan.land.z, lead) + 0.6,
  };
  if (!plan.moves) return { pos, look: dropLook, zoom: 1 };

  // The lens: through the climb it closes in, telephoto, to suit how far the ball has
  // gone by the time the camera glides; from there it runs straight on to DROP_ZOOM at
  // touchdown (out from a drive's telephoto, in from a wedge's, never breathing back on
  // the way), so the falling ball and its landing spot fill the frame; then about half
  // back out over the roll so the run-out stays in view. Eased at every hand-over.
  const roll = smooth(plan.flightTime + 0.3, plan.flightTime + 2.0, t);
  const zoom = t > plan.flightTime ? 1 + (DROP_ZOOM - 1) * (1 - 0.45 * roll)
    : t >= plan.glideStart ? lerp(plan.climbZoom, DROP_ZOOM, smooth(plan.glideStart, plan.flightTime, t))
      : 1 + (plan.climbZoom - 1) * smooth(Math.min(0.15, plan.glideStart / 2), plan.glideStart, t);

  // Climb framing, from wherever the camera is: aim so the ball rides CLIMB_FRAME above
  // the middle of the frame. It starts from the address framing (no jolt at impact) and
  // hands over to the descent framing as the camera glides away.
  const v = smooth(0, 1, u);
  const dx = dropLook.x - pos.x, dy = dropLook.y - pos.y;
  const horiz = Math.max(1, Math.hypot(dx, dy));
  const ballDist = Math.hypot(ball.x - pos.x, ball.y - pos.y);
  const halfZ = Math.atan(Math.tan(plan.halfFov) / zoom);
  const eBall = Math.atan2(ball.z - pos.z, Math.max(1, ballDist));
  let pitch = eBall - Math.atan(CLIMB_FRAME * Math.tan(halfZ));
  let az = Math.atan2(dx, dy);
  if (plan.startLook) {
    // ease in from the address look over the first half second
    const s = plan.startLook, w = smooth(0, 0.5, t);
    const sh = Math.max(1, Math.hypot(s.x - pos.x, s.y - pos.y));
    const sAz = Math.atan2(s.x - pos.x, s.y - pos.y);
    let dAz = az - sAz;
    dAz -= 2 * Math.PI * Math.round(dAz / (2 * Math.PI));
    az = sAz + dAz * w;
    pitch = lerp(Math.atan2(s.z - pos.z, sh), pitch, w);
  }
  const reach = Math.max(horiz, ballDist);
  const climbLook = {
    x: pos.x + Math.sin(az) * reach,
    y: pos.y + Math.cos(az) * reach,
    z: pos.z + Math.tan(pitch) * reach,
  };
  const look = { x: lerp(climbLook.x, dropLook.x, v), y: lerp(climbLook.y, dropLook.y, v), z: lerp(climbLook.z, dropLook.z, v) };
  // Whatever the framing asks for, the ball stays well inside the frame: a camera gliding
  // under a high ball can look far enough ahead to lose it from a telephoto frame. The
  // leash takes hold once the address framing has handed over (no jolt at impact).
  const leashed = leash(pos, look, ball, Math.atan(LEASH * Math.tan(halfZ)));
  const w = plan.startLook ? smooth(0, 0.5, t) : 1;
  return { pos, look: { x: lerp(look.x, leashed.x, w), y: lerp(look.y, leashed.y, w), z: lerp(look.z, leashed.z, w) }, zoom };
}

// The look target turned toward the ball until the ball is at most maxA off the line of
// sight: untouched up to 60% of that, then a smooth saturation (no kink where it engages).
function leash(pos, look, ball, maxA) {
  const l = [look.x - pos.x, look.y - pos.y, look.z - pos.z];
  const b = [ball.x - pos.x, ball.y - pos.y, ball.z - pos.z];
  const ll = Math.hypot(...l), bl = Math.hypot(...b);
  if (ll < 1e-6 || bl < 1e-6) return look;
  const a = Math.acos(clamp((l[0] * b[0] + l[1] * b[1] + l[2] * b[2]) / (ll * bl), -1, 1));
  const k = 0.6 * maxA;
  if (a <= k || a > Math.PI - 1e-3) return look;
  const a2 = k + (maxA - k) * Math.tanh((a - k) / (maxA - k));
  // slerp from the ball's direction toward the look's, stopping a2 off the ball
  const s = Math.sin(a), w0 = Math.sin(a - a2) / s, w1 = Math.sin(a2) / s;
  const d = [0, 1, 2].map((i) => w0 * b[i] / bl + w1 * l[i] / ll);
  return { x: pos.x + d[0] * ll, y: pos.y + d[1] * ll, z: pos.z + d[2] * ll };
}

// Sliding-window max / mean over an array (window clipped at the ends).
function maxFilter(a, r) {
  return a.map((_, i) => { let m = -Infinity; for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) m = Math.max(m, a[k]); return m; });
}
function boxFilter(a, r) {
  return a.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) { s += a[k]; n++; } return s / n; });
}
