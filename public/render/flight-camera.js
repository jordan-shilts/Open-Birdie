// Shot-replay camera: a smooth "drone" follow that frames the flight. Pure (sim
// coordinates, no three) so the framing is unit-tested (test/flight-camera.test.mjs).
//
// The camera starts exactly where the address camera was (no cut at impact), holds
// that tee vantage through launch and the climb while the look target tracks the
// ball, then glides — on a raised arc, eased — to a vantage behind and beside the
// landing area during the descent, so the drop, the first bounce and the roll-out
// all happen in frame. Short shots (chips, putts) never move the camera.
import { flightMarkers, pointAt } from './flight-profile.js';

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, f) => a + (b - a) * f;

export const CAM_CLEARANCE_M = 2.0;   // never closer than this above the ground

// points: sim trajectory; startCam: {x,y,z} where the camera is now (sim frame);
// groundAt(x,y) -> terrain height; flightTime: s at first ground contact;
// isClear(x,y) -> false where the landing vantage would sit inside a tree.
export function flightCameraPlan(points, { startCam, groundAt = () => 0, flightTime = null, isPutt = false, isClear = () => true } = {}) {
  const p0 = points[0];
  const last = points[points.length - 1];
  const { apex, landing } = flightMarkers(points, flightTime);
  const land = landing || last;
  const carry = Math.hypot(land.x - p0.x, land.y - p0.y);
  const ft = Number.isFinite(flightTime) && flightTime > 0 ? flightTime : land.t;
  const start = startCam ? { ...startCam } : { x: p0.x, y: p0.y - 12, z: p0.z + 5 };
  const moves = !isPutt && carry >= 45;
  let end = { ...start };
  if (moves) {
    // unit vector tee -> landing and its right-hand normal
    const ux = (land.x - p0.x) / carry, uy = (land.y - p0.y) / carry;
    const rx = uy, ry = -ux;
    // sit on the side the ball curves AWAY from, so the descent isn't hidden behind
    // the camera's own line of sight (offline sign: + = right of the launch line)
    const off = (last.x - p0.x) * rx + (last.y - p0.y) * ry;
    const side = off > 0 ? -1 : 1;
    const back = clamp(carry * 0.30, 22, 70);
    const lateral = clamp(carry * 0.11, 6, 24);
    const lift = clamp(carry * 0.085, 6, 20);
    // preferred vantage first, then the other side, then further back / straight behind
    const candidates = [
      [back, lateral * side], [back, -lateral * side], [back * 1.35, lateral * side * 0.5],
      [back * 1.35, -lateral * side * 0.5], [back * 0.7, 0],
    ];
    let pick = candidates[0];
    for (const c of candidates) {
      const cx = land.x - ux * c[0] + rx * c[1], cy = land.y - uy * c[0] + ry * c[1];
      if (isClear(cx, cy)) { pick = c; break; }
    }
    const ex = land.x - ux * pick[0] + rx * pick[1];
    const ey = land.y - uy * pick[0] + ry * pick[1];
    end = { x: ex, y: ey, z: Math.max(groundAt(ex, ey), land.z) + lift };
  }
  return {
    p0, apex, land, last, carry, flightTime: ft, start, end, moves,
    glideStart: ft * 0.32, glideEnd: ft * 0.9,
    arc: moves ? clamp(carry * 0.06, 3, 16) : 0,
    groundAt,
  };
}

// Camera position + look target at sim time t.
export function flightCameraAt(plan, t, points) {
  const u = plan.moves ? smooth(plan.glideStart, plan.glideEnd, t) : 0;
  const x = lerp(plan.start.x, plan.end.x, u);
  const y = lerp(plan.start.y, plan.end.y, u);
  let z = lerp(plan.start.z, plan.end.z, u) + Math.sin(Math.PI * u) * plan.arc;
  z = Math.max(z, plan.groundAt(x, y) + CAM_CLEARANCE_M);
  const ball = pointAt(points, t) || plan.last;
  // Look slightly AHEAD of the ball toward the landing spot while it's in the air so
  // the drop zone enters frame before the ball does; settle on the ball once down.
  const air = t < plan.flightTime;
  const lead = air ? 0.22 * smooth(0, plan.flightTime * 0.5, t) : 0;
  const look = {
    x: lerp(ball.x, plan.land.x, lead),
    y: lerp(ball.y, plan.land.y, lead),
    z: lerp(ball.z, plan.land.z, lead) + 0.6,
  };
  return { pos: { x, y, z }, look };
}
