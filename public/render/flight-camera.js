// Shot-replay camera, two ways, both one continuous move from the address camera (no
// cuts). Pure (sim coordinates, no three) so the framing is unit-tested
// (test/flight-camera.test.mjs).
//
// 'follow' (the default in the game): the camera flies with the ball. The ball gets away
// at impact, the camera chases it along its own flight, catches it up and rides with it,
// looking where it is going; as the ball comes down it drops in level behind it, so the
// landing area and the horizon stay in view (the approach); then it eases off behind it
// for the bounce and the roll and comes to rest there (followCamera below).
//
// 'tv': broadcast-style coverage, framed so the ball's height reads.
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
import { flightMarkers, pointAt, smoothPointAt } from './flight-profile.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// the same with no kick in its acceleration at either end (for a camera that sets off)
const smoother = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * t * (t * (6 * t - 15) + 10); };
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
// the follow camera
export const FOLLOW_BACK_M = 9;       // what it chases: this far behind the ball, along its flight...
export const FOLLOW_UP_M = 2.4;       // ...and this far above it
const FOLLOW_LOOK_AHEAD_M = 6;        // looks this far ahead of the ball, along its flight
const FOLLOW_DT = 1 / 120;            // the camera path is worked out at this step (s)
const FOLLOW_OMEGA = 4.5;             // rad/s: the critically damped chase
const FOLLOW_MATCH = 0.6;             // how much of what it chases' own speed it matches outright
const FOLLOW_TAKE_UP_S = 0.6;         // the chase's pull, taken up from nothing at impact
const FOLLOW_MATCH_IN_S = 0.3;        // the speed match, taken up over this
const FOLLOW_HEADSTART_M = 10;        // at impact it chases a point this much further back than the address camera
const FOLLOW_CATCH_UP_S = 2.5;        // ...closing to FOLLOW_BACK_M over this
export const FOLLOW_TAIL_S = 0.8;     // after the ball stops, the camera comes to rest over this
const FOLLOW_LOOK_IN_S = 0.45;        // the look leaves the address framing over this
const FOLLOW_SETTLE_S = 0.9;          // once the ball is down, what it chases moves behind it over this
export const SETTLE_BACK_M = 11;      // the spot it settles on: behind the ball...
const SETTLE_UP_M = 3.2;              // ...and above the ground under it
// the approach: as the ball comes down steeply the camera stops riding its flight path
// (which has it looking straight down at the turf) and drops in level behind it instead
export const APPROACH_SIN = Object.freeze([0.22, 0.6]);   // sine of the descent angle: starts at the first, complete at the second
export const APPROACH_UP_M = 1.2;     // then it sits this much higher above the ball than FOLLOW_UP_M
export const APPROACH_LOOK_DROP = 0.15;   // ...and looks ahead of it along the ground, this far down per metre

// points: sim trajectory; startCam / startLook: the address camera and its look target
// now (sim frame); groundAt(x,y) -> terrain height; treeTopAt(x,y) -> the height the
// camera must stay above there (-Infinity in the open; flyover.js treeCeiling);
// flightTime: s at first ground contact; isClear(x,y) -> false where the landing vantage
// would sit in a tree or look through one; fovDeg: the base (unzoomed) vertical lens.
export function flightCameraPlan(points, {
  startCam, startLook = null, groundAt = () => 0, treeTopAt = null, flightTime = null,
  isPutt = false, isClear = () => true, fovDeg = 58, mode = 'tv',
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
  if (moves && mode === 'follow') {
    return followCamera(points, {
      p0, apex, land, last, carry, flightTime: ft, start, moves, apexH, mode,
      startLook: startLook ? { ...startLook } : null, groundAt, treeTopAt,
    });
  }
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

// The follow camera's path, worked out once per shot at FOLLOW_DT and running on
// FOLLOW_TAIL_S past the ball's last sample. The camera chases a point on the ball's own
// flight (by arc length, so the point slows as the ball does) FOLLOW_UP_M above it and,
// behind the ball, FOLLOW_HEADSTART_M further back than the address camera stands at
// impact (so the camera never backs up as it sets off), closing to FOLLOW_BACK_M over
// FOLLOW_CATCH_UP_S (before the ball has gone that far, on the ground behind the ball's
// start): the ball gets away, then the camera catches it up and rides with it. The chase is critically damped, matches FOLLOW_MATCH of the point's own speed
// (steadied, and taken up over FOLLOW_MATCH_IN_S) outright, and its pull is taken up from
// nothing at impact: no kick as it sets off, and it never overshoots what it chases, so
// it never passes the ball. Once the
// ball is down, what it chases moves over FOLLOW_SETTLE_S to a spot SETTLE_BACK_M behind
// the ball and SETTLE_UP_M up, and over the tail the camera comes to rest there. It looks
// just ahead of the ball along its flight (at the ball, steadied over the bounces, once
// it's down); it leaves the address framing over FOLLOW_LOOK_IN_S; and it stays above the
// ground and the tree crowns, lifted smoothly where it has to.
function followCamera(points, plan) {
  const { flightTime: ft, start, groundAt, treeTopAt } = plan;
  const end = points[points.length - 1].t;
  const B = (t) => smoothPointAt(points, t, ft);
  const n = Math.max(1, Math.ceil((end + FOLLOW_TAIL_S) / FOLLOW_DT));
  const T = [], S = [], P = [];
  let s = 0, prev = B(0);
  for (let i = 0; i <= n; i++) {
    const t = i * FOLLOW_DT, p = B(Math.min(end, t));
    s += Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    T.push(t); S.push(s); P.push(p); prev = p;
  }
  // the way the ball goes across the ground, carried back past its start (the chased
  // point's first metres, at the start's height)
  const dx0 = plan.land.x - plan.p0.x, dy0 = plan.land.y - plan.p0.y, d0 = Math.hypot(dx0, dy0) || 1;
  const startBack = Math.max(FOLLOW_BACK_M, Math.hypot(start.x - P[0].x, start.y - P[0].y) + FOLLOW_HEADSTART_M);
  const onFlight = (sBack) => {
    if (sBack <= 0) return { x: P[0].x + dx0 / d0 * sBack, y: P[0].y + dy0 / d0 * sBack, z: P[0].z };
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= sBack) lo = mid; else hi = mid; }
    const f = (sBack - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
    return { x: lerp(P[lo].x, P[hi].x, f), y: lerp(P[lo].y, P[hi].y, f), z: lerp(P[lo].z, P[hi].z, f) };
  };
  const dirAt = (i) => {
    const a = P[Math.max(0, i - 5)], b = P[Math.min(n, i + 5)];
    const v = [b.x - a.x, b.y - a.y, b.z - a.z], L = Math.hypot(...v);
    return L > 1e-6 ? v.map((c) => c / L) : null;
  };
  let dir = [dx0 / d0, dy0 / d0, 0], flat = [dx0 / d0, dy0 / d0];
  // what the camera chases (on the flight behind the ball, then the spot behind it on the
  // ground) and where it looks, sample by sample
  const goal = [], aim = [], downs = [];
  let approach = 0;
  for (let i = 0; i <= n; i++) {
    const t = T[i], b = P[i];
    const d = dirAt(i);
    if (d) dir = d;
    const hl = Math.hypot(dir[0], dir[1]);
    if (hl > 0.05) flat = [dir[0] / hl, dir[1] / hl];
    const back = lerp(startBack, FOLLOW_BACK_M, smoother(0, FOLLOW_CATCH_UP_S, t));
    const a = onFlight(S[i] - back);
    const down = smoother(ft, ft + FOLLOW_SETTLE_S, t);
    // The approach. Riding the flight path behind a ball that is coming down at 45 degrees
    // puts the camera high over it, looking down its own trail at a frame full of turf.
    // So the steeper the ball falls, the more the camera leaves the path for a spot level
    // behind it (the way it goes over the ground), a little above it, looking ahead along
    // the ground: the ball drops down the frame with the green, the pin and the horizon in
    // view. Held from just before touchdown (the bounce turns the ball's direction over
    // in one step; the settle below takes it from there).
    if (t < ft - 0.06) approach = smoother(APPROACH_SIN[0], APPROACH_SIN[1], -dir[2]);
    const air = {
      x: lerp(a.x, b.x - flat[0] * back, approach),
      y: lerp(a.y, b.y - flat[1] * back, approach),
      z: lerp(a.z, b.z + APPROACH_UP_M, approach) + FOLLOW_UP_M,
    };
    goal.push({
      x: lerp(air.x, b.x - flat[0] * SETTLE_BACK_M, down),
      y: lerp(air.y, b.y - flat[1] * SETTLE_BACK_M, down),
      z: lerp(air.z, b.z + SETTLE_UP_M, down),
    });
    downs.push(down);
    const lead = FOLLOW_LOOK_AHEAD_M * (1 - down);
    aim.push({
      x: b.x + lerp(dir[0], flat[0], approach) * lead,
      y: b.y + lerp(dir[1], flat[1], approach) * lead,
      z: b.z + lerp(dir[2], -APPROACH_LOOK_DROP, approach) * lead + 0.3 * down,
    });
  }
  // its speed, steadied (the jolt of the ball meeting the ground taken out), matched in
  // part outright through the flight and let go as the ball comes down
  const vr = Math.round(0.05 / FOLLOW_DT), sr = Math.round(0.15 / FOLLOW_DT);
  const goalV = ['x', 'y', 'z'].map((k) => boxFilter(boxFilter(goal.map((_, i) => {
    const i0 = Math.max(0, i - vr), i1 = Math.min(n, i + vr);
    return (goal[i1][k] - goal[i0][k]) / Math.max(FOLLOW_DT, (i1 - i0) * FOLLOW_DT);
  }), sr), sr));
  const pos = [];
  const cam = { ...start }, camV = { x: 0, y: 0, z: 0 };
  ['x', 'y', 'z'].forEach((k, j) => {
    cam[k] = start[k];
    camV[k] = 0;
    for (let i = 0; i <= n; i++) {
      const w = FOLLOW_OMEGA * smoother(0, FOLLOW_TAKE_UP_S, T[i]);
      const match = FOLLOW_MATCH * smoother(0, FOLLOW_MATCH_IN_S, T[i]) * (1 - downs[i]) * goalV[j][i];
      camV[k] += (w * w * (goal[i][k] - cam[k]) + 2 * w * (match - camV[k])) * FOLLOW_DT;
      cam[k] += camV[k] * FOLLOW_DT;
      if (!pos[i]) pos[i] = {};
      pos[i][k] = cam[k];
    }
  });
  // the look, steadied (a centred average: no lag, and the turn from the descent to the
  // roll and the bounces smoothed out), eased out of the address framing
  const r = Math.round(0.12 / FOLLOW_DT);
  const steady = ['x', 'y', 'z'].map((k) => boxFilter(boxFilter(aim.map((q) => q[k]), r), r));
  const sl = plan.startLook || P[0];
  const look = aim.map((_, i) => {
    const w = smoother(0, FOLLOW_LOOK_IN_S, T[i]);
    return { x: lerp(sl.x, steady[0][i], w), y: lerp(sl.y, steady[1][i], w), z: lerp(sl.z, steady[2][i], w) };
  });
  // the tail: onto the spot behind the resting ball, arriving still
  const restAt = goal[n], from = Math.max(ft + 0.3, end + FOLLOW_TAIL_S - 1.1);
  for (let i = 0; i <= n; i++) {
    const a = smoother(from, end + FOLLOW_TAIL_S, T[i]);
    if (a <= 0) continue;
    for (const k of ['x', 'y', 'z']) pos[i][k] = lerp(pos[i][k], restAt[k], a);
  }
  // above the ground and the tree crowns, lifted smoothly (and not at all at impact)
  const need = pos.map((c, i) => {
    let top = groundAt(c.x, c.y) + CAM_CLEARANCE_M;
    if (treeTopAt) top = Math.max(top, treeTopAt(c.x, c.y));
    return Math.max(0, top - c.z) * smoother(0, FOLLOW_TAKE_UP_S, T[i]);
  });
  if (need.some((v) => v > 0)) {
    const rr = Math.round(0.25 / FOLLOW_DT);
    const lift = boxFilter(maxFilter(need, rr), rr);
    pos.forEach((c, i) => { c.z += lift[i]; });
  }
  return { ...plan, end: pos[pos.length - 1], tail: FOLLOW_TAIL_S, path: { dt: FOLLOW_DT, pos, look }, zoom: 1 };
}

function followAt(plan, t) {
  const { dt, pos, look } = plan.path;
  const f = clamp(t / dt, 0, pos.length - 1), i = Math.min(pos.length - 2, Math.floor(f)), u = f - i;
  const at = (a) => (a.length < 2 ? { ...a[0] } : { x: lerp(a[i].x, a[i + 1].x, u), y: lerp(a[i].y, a[i + 1].y, u), z: lerp(a[i].z, a[i + 1].z, u) });
  return { pos: at(pos), look: at(look), zoom: 1 };
}

// Camera position + look target + lens zoom at sim time t.
export function flightCameraAt(plan, t, points) {
  if (plan.mode === 'follow') return followAt(plan, t);
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
