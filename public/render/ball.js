// The golf ball: a dimpled white ball with an alignment line and a logo, so it can be
// seen to turn, and how it turns through a replay: backspin in the air, a true roll on
// the ground. ballTurn is pure (sim frame, no three) and unit-tested
// (test/ball-spin.test.mjs); makeBallTexture draws on a canvas.

// The fastest the ball is drawn spinning in the air (rev/s). A wedge's real 9000 rpm is
// 150 rev/s, which a 60 Hz frame would strobe into a slow backward wobble; at this rate it
// reads as spinning, on the right axis, in the right direction.
export const MAX_SHOWN_SPIN_RPS = 6;

// The ball's turn over one replay step from `from` to `to` (sim m: x east, y north, z
// up). In the air, backspin: the top of the ball turns back toward the golfer (the axis
// is the flight's direction crossed with up), tilted about the flight by the spin axis
// (+ a fade's, the way the ball curves right), at spinRps capped to MAX_SHOWN_SPIN_RPS.
// On the ground, a roll without slipping: the top turns forward, through the distance
// covered over the ball's (drawn) radius. Returns { axis: [x, y, z] (unit), angle (rad) },
// or null when the ball didn't move across the ground.
export function ballTurn(from, to, dt, { air = false, spinRps = 0, spinAxisDeg = 0, radius = 0.0214 } = {}) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-6) || !(dt > 0)) return null;
  const hx = dx / d, hy = dy / d;
  if (air) {
    const rps = Math.min(Math.max(spinRps, 0), MAX_SHOWN_SPIN_RPS);
    if (!(rps > 0)) return null;
    const a = (spinAxisDeg || 0) * Math.PI / 180;
    // (hy, -hx, 0) is backspin's axis (omega x v points up: lift); tilting it toward -z
    // turns that lift to the right of the flight, as a fade's spin does
    return { axis: [hy * Math.cos(a), -hx * Math.cos(a), -Math.sin(a)], angle: 2 * Math.PI * rps * dt };
  }
  return { axis: [-hy, hx, 0], angle: d / radius };
}

// A ball's surface on an equirectangular canvas (the sphere's UVs): off-white, a fine
// staggered grid of dimples, a thin alignment line round its middle and a small logo.
export function makeBallTexture(doc = document) {
  const W = 512, H = 256;
  const cv = doc.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#f5f5f1';
  g.fillRect(0, 0, W, H);
  // dimples: rows of soft dots, wider apart toward the poles (the map stretches there)
  for (let row = 0; row < 22; row++) {
    const v = (row + 0.5) / 22;
    const lat = (v - 0.5) * Math.PI;
    const n = Math.max(6, Math.round(44 * Math.cos(lat)));
    for (let k = 0; k < n; k++) {
      const u = (k + (row % 2) * 0.5) / n;
      const x = u * W, y = v * H, r = 3.2;
      const grad = g.createRadialGradient(x - 0.8, y - 0.8, 0.3, x, y, r);
      grad.addColorStop(0, 'rgba(150,150,145,0.30)');
      grad.addColorStop(1, 'rgba(150,150,145,0)');
      g.fillStyle = grad;
      g.beginPath(); g.ellipse(x, y, r / Math.max(0.35, Math.cos(lat)), r, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // the alignment line, round the ball's middle
  g.fillStyle = '#26272b';
  g.fillRect(0, H / 2 - 2, W, 4);
  // a logo either side of it, and the number on the back
  g.fillStyle = '#d6322f';
  g.beginPath();
  g.moveTo(W * 0.25 - 22, H / 2 - 12); g.lineTo(W * 0.25 + 22, H / 2 - 12); g.lineTo(W * 0.25, H / 2 - 34);
  g.closePath(); g.fill();
  g.fillStyle = '#26272b';
  g.font = '700 30px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('1', W * 0.75, H / 2 + 26);
  return cv;
}
