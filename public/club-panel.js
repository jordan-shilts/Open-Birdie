// The club card beside the last shot (index.html #clubpanel): club path and face from
// above, attack angle and loft from the side, and the strike — the TrackMan "club
// delivery" screens. Data: shot.clubData from lib/club-delivery.js. A number the
// launch monitor didn't measure is worked out from the ball's flight and marked "est";
// one that can't be (attack angle and loft without an attack angle) shows a dash.
//
// Top view: the target straight up, the ball in the middle; the path (blue) and the
// face (red) are drawn three times their angle so a 2-degree path reads at a glance.
// Side view: the target to the right; attack (blue), loft (red) and launch (white) at
// their true angles, the spin loft shaded between attack and loft.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const DEG = Math.PI / 180;
const fmt = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

function side(v, pos, neg, zero = 'square') {
  if (!v || Math.abs(v.v) < 0.05) return zero;
  return v.v > 0 ? pos : neg;
}

function tile(label, v, word, { unit = '°' } = {}) {
  if (!v) return `<div class="cp-tile"><span class="lbl">${label}</span><b class="cp-none">–</b><em>not measured</em></div>`;
  return `<div class="cp-tile${v.est ? ' est' : ''}"><span class="lbl">${label}</span><b>${fmt(v.v)}<small>${unit}</small></b>`
    + `<em>${esc(word)}${v.est ? ' · est' : ''}</em></div>`;
}

// a ray from (x, y) at angle a (radians, 0 = up, clockwise positive), length L
const ray = (x, y, a, L) => [x + Math.sin(a) * L, y - Math.cos(a) * L];

function topView(d) {
  const cx = 160, cy = 92, k = 3, cap = 36 * DEG;
  const ang = (v) => Math.max(-cap, Math.min(cap, (v ? v.v : 0) * k * DEG));
  const pa = ang(d.path), fa = ang(d.face), sa = ang({ v: d.start });
  const [p0x, p0y] = ray(cx, cy, pa + Math.PI, 74), [p1x, p1y] = ray(cx, cy, pa, 44);
  const [s1x, s1y] = ray(cx, cy, sa, 78);
  // the face: a short line square to its aim, just behind the ball, and its aim
  const [bx, by] = ray(cx, cy, fa + Math.PI, 16);
  const [f0x, f0y] = ray(bx, by, fa - Math.PI / 2, 26), [f1x, f1y] = ray(bx, by, fa + Math.PI / 2, 26);
  const [n1x, n1y] = ray(bx, by, fa, 58);
  const head = (x, y, a, c) => {
    const [l1x, l1y] = ray(x, y, a + Math.PI - 0.45, 11), [l2x, l2y] = ray(x, y, a + Math.PI + 0.45, 11);
    return `<path d="M${l1x.toFixed(1)} ${l1y.toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}L${l2x.toFixed(1)} ${l2y.toFixed(1)}" class="${c}"/>`;
  };
  return `<svg viewBox="0 0 320 168" class="cp-svg" aria-hidden="true">
    <line x1="${cx}" y1="160" x2="${cx}" y2="6" class="cp-target"/>
    <text x="${cx + 6}" y="16" class="cp-note">TARGET</text>
    <line x1="${cx}" y1="${cy}" x2="${s1x.toFixed(1)}" y2="${s1y.toFixed(1)}" class="cp-start"/>
    <line x1="${p0x.toFixed(1)}" y1="${p0y.toFixed(1)}" x2="${p1x.toFixed(1)}" y2="${p1y.toFixed(1)}" class="cp-path"/>
    ${head(p1x, p1y, pa, 'cp-path')}
    <line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${n1x.toFixed(1)}" y2="${n1y.toFixed(1)}" class="cp-aim"/>
    <line x1="${f0x.toFixed(1)}" y1="${f0y.toFixed(1)}" x2="${f1x.toFixed(1)}" y2="${f1y.toFixed(1)}" class="cp-face"/>
    <circle cx="${cx}" cy="${cy}" r="8" class="cp-ball"/>
    <text x="8" y="162" class="cp-note">ANGLES ×3</text>
  </svg>`;
}

function sideView(d) {
  const gx = 120, gy = 108, r = 9;
  const bx = gx + 14, by = gy - r;
  const toXY = (deg, L, x = bx, y = by) => [x + Math.cos(deg * DEG) * L, y - Math.sin(deg * DEG) * L];
  const launch = d.launch;
  const [lx, ly] = toXY(launch, 150);
  let extra = '';
  if (d.attack) {
    const a = d.attack.v;
    const [a0x, a0y] = toXY(a + 180, 96, bx, by + r * 0.4);
    const [a1x, a1y] = toXY(a, 40, bx, by + r * 0.4);
    extra += `<line x1="${a0x.toFixed(1)}" y1="${a0y.toFixed(1)}" x2="${a1x.toFixed(1)}" y2="${a1y.toFixed(1)}" class="cp-path"/>`;
  }
  if (d.dynamicLoft) {
    const lo = d.dynamicLoft.v;
    const [l1x, l1y] = toXY(lo, 118);
    // the face, leaning back by its loft, behind the ball
    const fx = bx - r - 3;
    const [ft1x, ft1y] = [fx - Math.sin(lo * DEG) * 52, gy - Math.cos(lo * DEG) * 52];
    extra += `<line x1="${fx}" y1="${gy}" x2="${ft1x.toFixed(1)}" y2="${ft1y.toFixed(1)}" class="cp-face"/>`;
    if (d.attack) {
      const a = d.attack.v, R = 70;
      const [s0x, s0y] = toXY(a, R), [s1x, s1y] = toXY(lo, R);
      extra = `<path d="M${bx} ${by}L${s0x.toFixed(1)} ${s0y.toFixed(1)}A${R} ${R} 0 0 0 ${s1x.toFixed(1)} ${s1y.toFixed(1)}Z" class="cp-sector"/>` + extra;
    }
    extra += `<line x1="${bx}" y1="${by}" x2="${l1x.toFixed(1)}" y2="${l1y.toFixed(1)}" class="cp-aim"/>`;
  }
  return `<svg viewBox="0 0 320 124" class="cp-svg" aria-hidden="true">
    <line x1="8" y1="${gy}" x2="312" y2="${gy}" class="cp-ground"/>
    <text x="312" y="${gy + 13}" class="cp-note" text-anchor="end">TARGET →</text>
    ${extra}
    <line x1="${bx}" y1="${by}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" class="cp-start"/>
    <circle cx="${bx}" cy="${by}" r="${r}" class="cp-ball"/>
  </svg>`;
}

// Where on the face the ball came off (mm from the centre, + toe, + up), when the
// monitor measures it: an iron or wood face outline with the strike as a dot.
function faceView(d, wood) {
  if (!d.impact) return '';
  const W = 120, H = 66, s = wood ? 1.6 : 2.1;   // px per mm
  const x = Math.max(-W / 2 + 6, Math.min(W / 2 - 6, d.impact.x * s));
  const y = Math.max(-H / 2 + 6, Math.min(H / 2 - 6, -d.impact.y * s));
  const outline = wood
    ? `<path d="M14 40 Q14 12 50 10 L96 8 Q122 10 122 38 Q122 62 92 66 L40 68 Q14 66 14 40Z" class="cp-faceplate"/>`
    : `<path d="M10 18 L112 10 Q124 10 124 24 L122 62 Q120 70 108 70 L16 70 Q8 70 8 60Z" class="cp-faceplate"/>`;
  return `<svg viewBox="0 0 132 80" class="cp-impact" aria-label="Strike on the face">
    ${outline}<line x1="66" y1="16" x2="66" y2="66" class="cp-sweet"/>
    <circle cx="${(66 + x).toFixed(1)}" cy="${(40 + y).toFixed(1)}" r="6" class="cp-dot"/></svg>`;
}

export function renderClubPanel(el, d, { clubName = '', wood = false } = {}) {
  if (!el) return;
  if (!d) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const strike = d.strike ? `<span class="cp-chip ${d.strike === 'centered' ? 'good' : d.strike === 'off-center' ? 'bad' : ''}">${esc(d.strike)}</span>` : '';
  const smash = d.smash != null
    ? `<div class="cp-tile"><span class="lbl">SMASH</span><b>${d.smash.toFixed(2)}</b><em>best ${d.bestSmash.toFixed(2)}</em></div>`
    : '<div class="cp-tile"><span class="lbl">SMASH</span><b class="cp-none">–</b><em>no club speed</em></div>';
  const speed = d.clubSpeed != null
    ? `<div class="cp-tile"><span class="lbl">CLUB SPEED</span><b>${d.clubSpeed.toFixed(1)}<small>mph</small></b><em>measured</em></div>`
    : '<div class="cp-tile"><span class="lbl">CLUB SPEED</span><b class="cp-none">–</b><em>not measured</em></div>';
  el.innerHTML = `
    <div class="cp-head"><span class="lbl">CLUB DELIVERY</span><span class="sp-club">${esc(clubName)}</span>${strike}</div>
    ${topView(d)}
    <div class="cp-tiles">
      ${tile('CLUB PATH', d.path, side(d.path, 'in to out', 'out to in'))}
      ${tile('FACE ANGLE', d.face, side(d.face, 'open', 'closed'))}
      ${tile('FACE TO PATH', d.faceToPath, side(d.faceToPath, 'open', 'closed'))}
    </div>
    ${sideView(d)}
    <div class="cp-tiles">
      ${tile('ATTACK', d.attack, d.attack ? (d.attack.v >= 0 ? 'up' : 'down') : '')}
      ${tile('DYN. LOFT', d.dynamicLoft, 'at impact')}
      ${tile('SPIN LOFT', d.spinLoft, 'loft − attack')}
    </div>
    <div class="cp-strike">
      <div class="cp-tiles two">${smash}${speed}</div>
      ${faceView(d, wood)}
    </div>`;
  el.classList.remove('hidden');
}
