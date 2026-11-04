// The overhead aim map's framing (aim-map.js): how much of the hole it shows, at what
// scale, and where the ball sits. A full shot puts the ball at the bottom with the line
// of play straight up and frames out past the pin (or where the club stops). Near the
// green, a chip or a putt, it frames the green itself with the ball and the cup in it,
// as close as the map allows: the shot that matters is a few metres long.
//
// Map frame (m): u to the right of the line of play, v along it, the ball at (0, 0).

const YD = 0.9144;
export const NEAR_YD = 40;   // the pin inside this: a shot round the green
const PAD_TOP = 18, PAD_BOT = 30;
const NEAR_PAD_M = 4;        // room round the green, the ball and the cup
const NEAR_MIN_M = 18;       // never tighter than this across: a tap-in still shows its green

// A shot round the green: a putt, or the pin inside NEAR_YD.
export const isNearGreen = (pinYd, putt = false) => !!putt || pinYd < NEAR_YD;

// Wc, Hc: the map's size (px). pinUV, restUV (or null): the pin and where the predicted
// shot stops; greenUV: the pin's green outline (may be empty), all in the map frame.
// Returns the scale (px per m), the ball's position (px) and whether it is a near view.
export function frameMap(Wc, Hc, { pinUV, restUV = null, greenUV = [], putt = false }) {
  const [pu, pv] = pinUV;
  const near = isNearGreen(Math.hypot(pu, pv) / YD, putt);
  if (!near) {
    let reach = Math.max(pv + 22, 70);
    let half = Math.max(Math.abs(pu) + 22, 42);
    if (restUV) {
      reach = Math.max(reach, restUV[1] + 30);
      half = Math.max(half, Math.abs(restUV[0]) + 26);
    }
    const s = Math.min((Hc - PAD_TOP - PAD_BOT) / reach, (Wc / 2 - 10) / half);
    return { s, ox: Wc / 2, oy: Hc - PAD_BOT, near };
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of [[0, 0], [pu, pv], ...greenUV, ...(restUV ? [restUV] : [])]) {
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const span = (a, b) => {
    const grow = Math.max(0, NEAR_MIN_M - (b - a + 2 * NEAR_PAD_M)) / 2;
    return [a - NEAR_PAD_M - grow, b + NEAR_PAD_M + grow];
  };
  [u0, u1] = span(u0, u1);
  [v0, v1] = span(v0, v1);
  const H = Hc - PAD_TOP - PAD_BOT;
  const s = Math.min(H / (v1 - v0), (Wc - 20) / (u1 - u0));
  return { s, ox: Wc / 2 - ((u0 + u1) / 2) * s, oy: PAD_TOP + H / 2 + ((v0 + v1) / 2) * s, near };
}
