'use strict';
// Club delivery for the shot panel (public/club-panel.js): what the launch monitor
// measured of the club (Open Connect ClubData) and what the ball's flight says about
// the rest — club path, face angle, face to path, attack angle, dynamic and spin loft,
// and the strike (smash factor, and where on the face when the monitor knows).
//
// Measured fields pass through. OpenFlight sends club speed and path (its radar);
// monitors with cameras also send face angle, attack angle, dynamic loft and the
// impact point on the face. Open Connect has no "missing": a field left at exactly 0 is
// taken as not measured.
//
// Estimates (est: true) come from the ball, by the D-plane:
//  - The ball starts mostly where the face points and partly along the path: about 85%
//    face with a driver, 75% with a mid iron, 70% with a wedge (face weight w below).
//    With a measured path: face = (start - (1 - w) path) / w.
//  - Its spin axis tilts with face to path: sin(face to path) ~ tan(tilt) sin(spin loft).
//    Without a path, face to path comes from the spin axis (spin loft from the launch
//    and the club's typical attack angle), then face and path from the start direction.
//  - With an attack angle: launch ~ 0.85 dynamic loft + 0.15 attack, so dynamic loft =
//    (launch - 0.15 attack) / 0.85, and spin loft = dynamic loft - attack.
// Signs, for a right-hander as GSPro's API has them: right of target, open, in-to-out
// and up are positive.

const DEG = Math.PI / 180;

// per club: face weight in the start direction, typical attack angle (deg), and the
// best smash factor (ball speed / club speed) a centred strike gets
const CLUBS = {
  DR: { w: 0.86, aoa: -1.0, smash: 1.50 },
  W3: { w: 0.84, aoa: -2.5, smash: 1.47 },
  H3: { w: 0.8, aoa: -3.0, smash: 1.43 },
  I4: { w: 0.78, aoa: -3.5, smash: 1.39 },
  I5: { w: 0.78, aoa: -3.7, smash: 1.38 },
  I6: { w: 0.76, aoa: -4.0, smash: 1.36 },
  I7: { w: 0.75, aoa: -4.2, smash: 1.34 },
  I8: { w: 0.74, aoa: -4.4, smash: 1.31 },
  I9: { w: 0.72, aoa: -4.6, smash: 1.28 },
  PW: { w: 0.7, aoa: -4.8, smash: 1.24 },
  SW: { w: 0.68, aoa: -5.0, smash: 1.18 },
  LW: { w: 0.66, aoa: -5.0, smash: 1.14 },
};
const MID = CLUBS.I7;

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const measured = (v) => { const n = num(v); return Number.isFinite(n) && n !== 0 ? n : null; };
const r1 = (v) => Math.round(v * 10) / 10;
const val = (v, est) => (Number.isFinite(v) ? { v: r1(v), est } : null);

// How clean the strike was, from the smash factor against the club's best.
function strikeQuality(smash, best) {
  if (!(smash > 0) || !(best > 0)) return null;
  const k = smash / best;
  return k >= 0.97 ? 'centered' : k >= 0.93 ? 'slightly off' : 'off-center';
}

// raw: Open Connect ClubData (or null); ball: BallData {Speed, VLA, HLA, SpinAxis,
// TotalSpin, BackSpin, SideSpin}; clubKey: the shot's club (lib/game.js clubKey) or null.
// Returns null for a putt or a shot without ball data.
function clubDelivery(raw, ball, clubKey = null, { isPutt = false } = {}) {
  if (isPutt || !ball) return null;
  const ballSpeed = num(ball.Speed), launch = num(ball.VLA), start = num(ball.HLA) || 0;
  if (!(ballSpeed > 0) || !Number.isFinite(launch)) return null;
  let axis = num(ball.SpinAxis);
  if (!Number.isFinite(axis)) {
    const back = num(ball.BackSpin), side = num(ball.SideSpin);
    axis = Number.isFinite(back) && Number.isFinite(side) && (back || side) ? Math.atan2(side, back) / DEG : 0;
  }
  const c = CLUBS[clubKey] || MID;
  const m = raw || {};
  const clubSpeed = measured(m.Speed) ?? measured(m.SpeedAtImpact);
  const pathM = measured(m.Path), faceM = measured(m.FaceToTarget);
  const attackM = measured(m.AngleOfAttack), loftM = measured(m.Loft);
  const impactH = measured(m.HorizontalFaceImpact), impactV = measured(m.VerticalFaceImpact);

  // attack and loft first: the spin loft feeds the face-to-path estimate
  const attack = attackM !== null ? { v: r1(attackM), est: false } : null;
  let loft = null;
  if (loftM !== null) loft = { v: r1(loftM), est: false };
  else if (attack) loft = val((launch - 0.15 * attack.v) / 0.85, true);
  const spinLoft = loft && attack ? val(loft.v - attack.v, loft.est) : null;
  // the spin loft for the axis estimate: the real one, else from the launch and the
  // club's typical attack angle
  const sl = spinLoft ? spinLoft.v : (launch - 0.15 * c.aoa) / 0.85 - c.aoa;

  let path, face, f2p;
  if (pathM !== null && faceM !== null) {
    path = { v: r1(pathM), est: false }; face = { v: r1(faceM), est: false };
    f2p = { v: r1(faceM - pathM), est: false };
  } else if (pathM !== null) {
    path = { v: r1(pathM), est: false };
    const f = (start - (1 - c.w) * pathM) / c.w;
    face = val(f, true); f2p = val(f - pathM, true);
  } else if (faceM !== null) {
    face = { v: r1(faceM), est: false };
    const p = (start - c.w * faceM) / (1 - c.w);
    path = val(p, true); f2p = val(faceM - p, true);
  } else {
    const s = Math.tan(axis * DEG) * Math.sin(Math.max(4, sl) * DEG);
    const ftp = Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
    const f = start + (1 - c.w) * ftp;
    face = val(f, true); path = val(f - ftp, true); f2p = val(ftp, true);
  }

  const smash = clubSpeed ? ballSpeed / clubSpeed : null;
  return {
    clubSpeed: clubSpeed ? r1(clubSpeed) : null,
    smash: smash ? Math.round(smash * 100) / 100 : null,
    bestSmash: c.smash,
    strike: strikeQuality(smash, c.smash),
    // where on the face, mm from its centre: + toward the toe, + up
    impact: impactH !== null || impactV !== null ? { x: r1(impactH ?? 0), y: r1(impactV ?? 0) } : null,
    path, face, faceToPath: f2p, attack, dynamicLoft: loft, spinLoft,
    launch: r1(launch), start: r1(start), spinAxis: r1(axis),
  };
}

module.exports = { clubDelivery, strikeQuality, CLUB_DELIVERY: CLUBS };
