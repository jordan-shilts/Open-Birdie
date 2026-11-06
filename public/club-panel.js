// The club card beside the last shot (index.html #clubpanel): club path and face, the
// strike, and attack and loft when the monitor measures them — kept small, so it never
// crowds the view. Data: shot.clubData from lib/club-delivery.js. A number the launch
// monitor didn't measure is worked out from the ball's flight and marked "est".
//
// The sketch is the club from above: the target straight up, the path (blue arrow) and
// the face (red) drawn three times their angle so a 2-degree path reads at a glance.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const DEG = Math.PI / 180;
const fmt = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

function side(v, pos, neg) {
  if (!v || Math.abs(v.v) < 0.05) return 'square';
  return v.v > 0 ? pos : neg;
}

function row(label, v, word) {
  return `<div class="cp-row${v.est ? ' est' : ''}"><span class="lbl">${label}</span>`
    + `<b>${fmt(v.v)}°</b><em>${esc(word)}${v.est ? ' · est' : ''}</em></div>`;
}

// a point from (x, y) at angle a (radians, 0 = up, clockwise positive), distance L
const at = (x, y, a, L) => [x + Math.sin(a) * L, y - Math.cos(a) * L];
const f1 = (v) => v.toFixed(1);

function sketch(d) {
  const cx = 34, cy = 40, k = 3, cap = 36 * DEG;
  const ang = (v) => Math.max(-cap, Math.min(cap, (v ? v.v : 0) * k * DEG));
  const pa = ang(d.path), fa = ang(d.face);
  const [p0x, p0y] = at(cx, cy, pa + Math.PI, 30), [p1x, p1y] = at(cx, cy, pa, 26);
  const [h1x, h1y] = at(p1x, p1y, pa + Math.PI - 0.5, 7), [h2x, h2y] = at(p1x, p1y, pa + Math.PI + 0.5, 7);
  const [bx, by] = at(cx, cy, fa + Math.PI, 8);
  const [f0x, f0y] = at(bx, by, fa - Math.PI / 2, 13), [f2x, f2y] = at(bx, by, fa + Math.PI / 2, 13);
  return `<svg viewBox="0 0 68 76" class="cp-sketch" aria-hidden="true">
    <line x1="${cx}" y1="74" x2="${cx}" y2="2" class="cp-target"/>
    <line x1="${f1(p0x)}" y1="${f1(p0y)}" x2="${f1(p1x)}" y2="${f1(p1y)}" class="cp-path"/>
    <path d="M${f1(h1x)} ${f1(h1y)}L${f1(p1x)} ${f1(p1y)}L${f1(h2x)} ${f1(h2y)}" class="cp-path"/>
    <line x1="${f1(f0x)}" y1="${f1(f0y)}" x2="${f1(f2x)}" y2="${f1(f2y)}" class="cp-face"/>
    <circle cx="${cx}" cy="${cy}" r="4.5" class="cp-ball"/>
  </svg>`;
}

// where on the face the ball came off (mm from its centre, + toe, + up), when measured
function strikeDot(d) {
  if (!d.impact) return '';
  const x = Math.max(-15, Math.min(15, d.impact.x * 0.9)), y = Math.max(-8, Math.min(8, -d.impact.y * 0.9));
  return `<svg viewBox="0 0 40 24" class="cp-face-icon" aria-label="Strike on the face">
    <rect x="2" y="2" width="36" height="20" rx="5" class="cp-faceplate"/>
    <circle cx="${f1(20 + x)}" cy="${f1(12 + y)}" r="3.2" class="cp-dot"/></svg>`;
}

export function renderClubPanel(el, d, { clubName = '' } = {}) {
  if (!el) return;
  if (!d || !d.path || !d.face) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const chip = d.strike
    ? `<span class="cp-chip ${d.strike === 'centered' ? 'good' : d.strike === 'off-center' ? 'bad' : ''}">${esc(d.strike)}</span>` : '';
  const smash = d.smash != null
    ? `<div class="cp-row"><span class="lbl">SMASH</span><b>${d.smash.toFixed(2)}</b><em></em>${strikeDot(d)}</div>`
    : (d.impact ? `<div class="cp-row"><span class="lbl">STRIKE</span><b></b><em></em>${strikeDot(d)}</div>` : '');
  const parts = [];
  if (d.clubSpeed != null) parts.push(`club <b>${d.clubSpeed.toFixed(1)}</b> mph`);
  if (d.attack) parts.push(`attack <b>${fmt(d.attack.v)}°</b>`);
  if (d.dynamicLoft) parts.push(`loft <b>${fmt(d.dynamicLoft.v)}°</b>`);
  el.innerHTML = `
    <div class="cp-head"><span class="lbl">CLUB</span><span class="sp-club">${esc(clubName)}</span>${chip}</div>
    <div class="cp-body">
      ${sketch(d)}
      <div class="cp-rows">
        ${row('PATH', d.path, side(d.path, 'in to out', 'out to in'))}
        ${row('FACE', d.face, side(d.face, 'open', 'closed'))}
        ${row('TO PATH', d.faceToPath, side(d.faceToPath, 'open', 'closed'))}
        ${smash}
      </div>
    </div>
    ${parts.length ? `<div class="cp-more">${parts.join(' · ')}</div>` : ''}`;
  el.classList.remove('hidden');
}
