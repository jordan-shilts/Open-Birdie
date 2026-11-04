// Overhead aim map: the hole from above, turned so the default line of play points up,
// with yardage arcs from the ball, the club's predicted flight (gold) and roll (dotted),
// the ~2-sigma landing and resting areas, the calm-air flight as a faint ghost (the
// gap between the two is what the wind is doing), the pin, the wind, and the live shot,
// plus yardage-book numbers: the front and back of the green and of every bunker and
// water hazard near the line (yardages.mjs). Click or drag on it to aim; double-click
// aims straight back at the pin.
//
// A full shot is drawn as a plan, the way a GPS card lays out a hole (shot-plan.mjs): two
// kinds of marker, a target (a crosshair where the shot stops) and the pin, joined by its
// legs, each with a quiet bubble of its length; on a par 4 or 5 the pin can't be reached
// from the target, a second target where to lay up, which can be dragged.
//
// It shows the hole being played and only that hole: course surfaces carry no hole of
// their own, so each goes to the hole whose line of play runs nearest it. This hole's
// tees, fairway, green and hazards are drawn in full, every other hole's fade into the
// rough, and a soft light along this hole's corridor (tee to green, and ball to pin)
// keeps the eye on it; a neighbouring tee or green never reads as part of this hole.
//
// Sim coordinates: metres, x east, y north. Compass headings clockwise from north.
import { greenFor, hazardsInPlay, hazardText, holeSurfaces } from './yardages.mjs';
import { frameMap } from './map-frame.mjs';

const YD = 0.9144, FT = 0.3048;
const DEG = Math.PI / 180;

// map palette: a dark course plan the gold prediction and white arcs read on
const PAL = {
  rough: '#1d2b1f', roughEdge: '#223324',
  fairway: '#3a6a37', tee: '#3f7139', range: '#355f33',
  green: '#5aa64c', bunker: '#d6c495', water: '#2c6c9e', waterEdge: '#4a8fc4',
  tree: 'rgba(8, 18, 10, 0.78)', treeHi: 'rgba(40, 70, 40, 0.55)',
};
// the other holes: their shapes stay readable as the course around this hole, a step
// above the rough, but never compete with it
const MUTED = {
  rough: '#1d2b1f', fairway: '#243827', tee: '#213325', range: '#223426',
  green: '#29422b', bunker: '#4a4636', water: '#285a80', waterEdge: '#356d98',
};
const Z = { rough: 0, range: 1, fairway: 1, tee: 2, green: 3, bunker: 4, water: 4 };
// This hole's corridor (m): half its width along the line of play, and the round
// spaces kept lit at the green, the tee and the ball.
const CORRIDOR_HALF_M = 44, GREEN_R_M = 40, TEE_R_M = 26, BALL_R_M = 22;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class AimMap {
  constructor(canvas, { onAim = null, onAimEnd = null, onPlan = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onAim = onAim;
    this.onAimEnd = onAimEnd;
    this.onPlan = onPlan;    // ({x, y}) while the lay-up target is dragged
    this.plan = null;        // shot-plan.mjs shotPlan()
    // yardage details (menu, off by default): the distance rings, the hazards' and the
    // green's numbers on a full shot. Off, a full shot is just its plan: the target, the
    // pin, the legs and their lengths.
    this.details = false;
    this.geo = null;
    this.hole = null;        // { ball: {x,y}, pin: [x,y], baseAimDeg, line }
    this.aimOffset = 0;
    this.pred = null;
    this.wind = null;        // { mph, fromDeg }
    this.shot = null;        // live / last shot points [{x,y,z,t}]
    this.marks = null;       // yardages.mjs yardageMarks(): { green, greenPoly, hazards }
    this._static = document.createElement('canvas');
    this._staticKey = '';
    this._dragging = false;
    this._bind();
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  setCourse(geo) { this.geo = geo; this._staticKey = ''; this.draw(); }
  setHole(hole) {
    const h = this.hole;
    const same = h && h.ball.x === hole.ball.x && h.ball.y === hole.ball.y && h.baseAimDeg === hole.baseAimDeg
      && h.pin[0] === hole.pin[0] && h.pin[1] === hole.pin[1];
    this.hole = hole;
    if (!same) { this._staticKey = ''; this.shot = null; }
    this.aimOffset = hole.aimOffset ?? this.aimOffset;
    this.draw();
  }
  setAim(offset) { this.aimOffset = offset; this.draw(); }
  // the safe spot AUTO is aiming at ({x, y, kind}), or null once the aim is moved by hand
  setAuto(spot) { this.auto = spot || null; this.draw(); }
  setPrediction(pred) { this.pred = pred; this.draw(); }
  setWind(wind) { this.wind = wind; this.draw(); }
  setShot(points) { this.shot = points && points.length > 1 ? points : null; this.draw(); }
  setYardages(marks) { this.marks = marks; this.draw(); }
  setPlan(plan) { this.plan = plan || null; this.draw(); }
  setDetails(on) { this.details = !!on; this.draw(); }
  // a full shot's yardage details are drawn (menu option, or no plan to stand for them)
  _detailsFor(view) { return this.details || view.near || !this._planFor(view); }
  // the plan drawn for this view: a full shot's, not round the green
  _planFor(view) {
    const p = this.plan;
    return p && p.targets?.length && !view.near && this.pred && !this.pred.isPutt ? p : null;
  }

  // ---- view transform: default line straight up; the ball near the bottom for a full
  // shot, the green filling the map round the green (map-frame.mjs) ----
  _view(Wc, Hc) {
    const { ball, pin, baseAimDeg } = this.hole;
    const a = baseAimDeg * DEG;
    const fwd = [Math.sin(a), Math.cos(a)], right = [Math.cos(a), -Math.sin(a)];
    const toUV = (x, y) => {
      const dx = x - ball.x, dy = y - ball.y;
      return [dx * right[0] + dy * right[1], dx * fwd[0] + dy * fwd[1]];
    };
    const putt = !!(this.pred && this.pred.isPutt);
    const rest = this.pred && this.pred.rest && !putt ? this.pred.rest : null;
    const { s, ox, oy, near } = frameMap(Wc, Hc, {
      pinUV: toUV(pin[0], pin[1]),
      restUV: rest ? toUV(rest.x, rest.y) : null,
      greenUV: this._greenPoly().map((p) => toUV(p[0], p[1])),
      putt,
    });
    const toPx = (x, y) => { const [u, v] = toUV(x, y); return [ox + u * s, oy - v * s]; };
    return { toUV, toPx, s, ox, oy, a, fwd, right, near };
  }

  // the pin's green outline (sim m), once per pin
  _greenPoly() {
    const { pin } = this.hole;
    const key = `${this.geo?.courseRevision ?? this.geo?.name}|${pin[0]},${pin[1]}`;
    if (this._greenKey !== key) { this._greenKey = key; this._green = (this.geo && greenFor(this.geo, pin)) || []; }
    return this._green;
  }

  _resizeBacking() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this._staticKey = ''; }
    // ui = visual px per layout px (the HUD's CSS zoom), so lines and type scale with it
    const ui = this.canvas.clientWidth ? r.width / this.canvas.clientWidth : 1;
    return { W, H, dpr, w: r.width, h: r.height, ui };
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const { W, H, dpr, w, h, ui } = this._resizeBacking();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this._layupPx = null;   // set again where the plan draws its lay-up
    if (!this.hole || !this.geo || w < 20 || h < 20) return;
    const view = this._view(w, h);
    const key = `${W}x${H}|${this.hole.ball.x},${this.hole.ball.y}|${this.hole.baseAimDeg}|${view.s.toFixed(4)}|${view.ox.toFixed(1)},${view.oy.toFixed(1)}`;
    if (key !== this._staticKey) { this._drawStatic(view, W, H, dpr, w, h); this._staticKey = key; }
    ctx.drawImage(this._static, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this._detailsFor(view)) this._drawArcs(ctx, view, w, h, ui);
    const aimBox = this._drawAim(ctx, view, w, h, ui);
    // label boxes so far: the aim's, the prediction's carry, stop and legs, then the
    // green's front and back, then the hazards by importance; each later label steers
    // clear of the earlier
    const placed = this._drawPrediction(ctx, view, ui);
    if (aimBox) placed.push(aimBox);
    if (this._detailsFor(view)) {
      this._drawGreenMarks(ctx, view, w, h, ui, placed);
      this._drawHazards(ctx, view, w, h, ui, placed);
    }
    this._drawShot(ctx, view, ui);
    this._drawPinBall(ctx, view, ui);
    this._drawWind(ctx, w, h, ui, view);
  }

  // course plan: surfaces, woods and tree canopies (cached per hole and size): every
  // other hole muted, this hole in full under the light of its corridor, the rest dimmed
  _drawStatic(view, W, H, dpr, w, h) {
    const c = this._static;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PAL.rough;
    ctx.fillRect(0, 0, w, h);
    const inView = (pts) => {
      for (const p of pts) {
        const [X, Y] = view.toPx(p[0], p[1]);
        if (X > -40 && X < w + 40 && Y > -40 && Y < h + 40) return true;
      }
      return false;
    };
    const poly = (g, pts) => {
      g.beginPath();
      pts.forEach((p, i) => { const [X, Y] = view.toPx(p[0], p[1]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.closePath();
    };
    const mine = this._focus();
    const surfs = (this.geo.surfaces || []).filter((su) => PAL[su.kind] && su.poly && su.poly.length >= 3 && inView(su.poly))
      .sort((a, b) => (Z[a.kind] ?? 1) - (Z[b.kind] ?? 1));
    const paint = (g, su, pal) => {
      poly(g, su.poly);
      g.fillStyle = pal[su.kind]; g.fill();
      if (su.kind === 'water') { g.strokeStyle = pal.waterEdge; g.lineWidth = 1; g.stroke(); }
    };
    // 1. the course around: lakes, then every surface muted
    for (const wt of this.geo.sceneryWater || []) {
      if (!wt.poly || wt.poly.length < 3 || !inView(wt.poly)) continue;
      paint(ctx, { kind: 'water', poly: wt.poly }, MUTED);
    }
    for (const su of surfs) paint(ctx, su, MUTED);
    // 2. this hole in full, faded out at the edge of its corridor
    const mask = this._corridorMask(view, W, H, dpr);
    const layer = this._layerCanvas(W, H);
    const lc = layer.getContext('2d');
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const wt of this.geo.sceneryWater || []) {
      if (wt.poly && wt.poly.length >= 3 && inView(wt.poly)) paint(lc, { kind: 'water', poly: wt.poly }, PAL);
    }
    for (const su of surfs) {
      if (!mine.has(su)) continue;
      paint(lc, su, PAL);
      if (su.kind === 'green') { lc.strokeStyle = 'rgba(255,255,255,0.35)'; lc.lineWidth = 1.2; lc.stroke(); }
    }
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'destination-in';
    lc.drawImage(mask, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 3. woods and lidar canopies: dark crowns with a lit rim toward the top of the map
    ctx.fillStyle = PAL.tree;
    for (const wd of this.geo.woods || []) {
      if (wd.length >= 3 && inView(wd)) { poly(ctx, wd); ctx.fill(); }
    }
    const trees = [];
    for (const t of this.geo.canopy || []) trees.push([t[0], t[1], Math.max(1.5, t[2] || 3)]);
    for (const t of this.geo.trees || []) trees.push([t[0], t[1], 3.5]);
    for (const [x, y, r] of trees) {
      const [X, Y] = view.toPx(x, y);
      const R = r * view.s;
      if (X < -R || X > w + R || Y < -R || Y > h + R) continue;
      ctx.beginPath(); ctx.arc(X, Y, Math.max(1.2, R), 0, Math.PI * 2);
      ctx.fillStyle = PAL.tree; ctx.fill();
      if (R > 2.5) {
        ctx.beginPath(); ctx.arc(X - R * 0.25, Y - R * 0.25, R * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = PAL.treeHi; ctx.fill();
      }
    }
    // 4. everything outside the corridor dimmed a little further
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, W, H);
    lc.fillStyle = 'rgba(6, 10, 7, 0.34)';
    lc.fillRect(0, 0, W, H);
    lc.globalCompositeOperation = 'destination-out';
    lc.drawImage(mask, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the hole's own line of play (doglegs), faint
    const line = this.hole.line;
    if (line && line.length > 1) {
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1;
      ctx.beginPath();
      line.forEach((p, i) => { const [X, Y] = view.toPx(p[0], p[1]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // This hole's surfaces (holeSurfaces), worked out once per hole and lie.
  _focus() {
    const { ball, pin, line } = this.hole;
    const key = `${this.geo.courseRevision ?? this.geo.name}|${pin[0]},${pin[1]}|${ball.x},${ball.y}|${line ? line.length : 0}`;
    if (this._focusKey !== key) {
      const others = line
        ? (this.geo.holes || []).map((h) => h.line).filter((l) => l && l.length > 1 && l !== line && !(l[l.length - 1][0] === pin[0] && l[l.length - 1][1] === pin[1]))
        : [];
      this._focusSet = holeSurfaces(this.geo, { ball, pin, line, others });
      this._focusKey = key;
    }
    return this._focusSet;
  }

  // The corridor as a soft-edged mask (device pixels): the line of play tee to green,
  // the ball to the pin, and round spaces at the green, the tee and the ball.
  _corridorMask(view, W, H, dpr) {
    const m = this._maskCanvas || (this._maskCanvas = document.createElement('canvas'));
    m.width = W; m.height = H;
    const g = m.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.filter = `blur(${Math.max(3, CORRIDOR_HALF_M * view.s * 0.22).toFixed(1)}px)`;
    g.strokeStyle = '#fff'; g.fillStyle = '#fff';
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = 2 * CORRIDOR_HALF_M * view.s;
    const { ball, pin, line } = this.hole;
    const stroke = (pts) => {
      g.beginPath();
      pts.forEach((p, i) => { const [X, Y] = view.toPx(p[0], p[1]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.stroke();
    };
    if (line && line.length > 1) stroke(line);
    stroke([[ball.x, ball.y], pin]);
    const disc = (x, y, r) => { const [X, Y] = view.toPx(x, y); g.beginPath(); g.arc(X, Y, r * view.s, 0, Math.PI * 2); g.fill(); };
    disc(pin[0], pin[1], GREEN_R_M);
    disc(ball.x, ball.y, BALL_R_M);
    if (line && line.length > 1) disc(line[0][0], line[0][1], TEE_R_M);
    return m;
  }

  _layerCanvas(W, H) {
    const l = this._layer || (this._layer = document.createElement('canvas'));
    l.width = W; l.height = H;
    return l;
  }

  // distance arcs from the ball, labelled on the right: every 50 y (25 y, 10 y on
  // shorter views) for a full shot, every 10 ft round the green
  _drawArcs(ctx, view, w, h, ui) {
    const { ox, oy, s } = view;
    const maxM = Math.hypot(Math.max(ox, w - ox), oy) / s;
    const unit = view.near ? FT : YD;
    const step = view.near ? 10 : maxM / YD > 260 ? 50 : maxM / YD > 110 ? 25 : 10;
    ctx.save();
    ctx.font = `700 ${10.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const band = this.pred && !this.pred.isPutt && !view.near && !this._planFor(view) ? this.pred.band : null;
    const dim = band ? 0.6 : 1;   // the club's own lines lead; the yardage grid steps back
    for (let d = step; d * unit < maxM; d += step) {
      const R = d * unit * s;
      const major = d % (step * 2) === 0 || step === 50;
      ctx.beginPath();
      ctx.arc(ox, oy, R, Math.PI * 1.08, Math.PI * 1.92);
      ctx.strokeStyle = major ? `rgba(255,255,255,${0.3 * dim})` : `rgba(255,255,255,${0.13 * dim})`;
      ctx.lineWidth = major ? 1.1 * ui : 0.8 * ui;
      ctx.stroke();
      if (!major) continue;
      // label where the arc leaves the right edge (or at 40 degrees right of the line)
      let ang = 40 * DEG;
      const xr = (w - ox - (view.near ? 36 : 22) * ui);
      if (R > xr) ang = Math.asin(xr / R);
      const lx = ox + Math.sin(ang) * R, ly = oy - Math.cos(ang) * R;
      if (ly < 10 || ly > h - 4) continue;
      const txt = view.near ? `${d} ft` : `${d}`;
      ctx.lineWidth = 3 * ui; ctx.strokeStyle = 'rgba(10,14,11,0.85)';
      ctx.strokeText(txt, lx + 3 * ui, ly);
      ctx.fillStyle = `rgba(255,255,255,${0.78 * (band ? 0.75 : 1)})`;
      ctx.fillText(txt, lx + 3 * ui, ly);
    }
    if (band) this._drawBand(ctx, view, band, ui);
    ctx.restore();
  }

  // The club's lines: its carry (solid gold) and the short and long edges of where it
  // lands (Tight or Generous), across the landing area with a little to spare.
  _drawBand(ctx, view, band, ui) {
    const { ox, oy, s } = view;
    const base = this.hole.baseAimDeg * DEG;
    const midB = (band.fromRad + band.toRad) / 2 - base;
    const halfMin = Math.min(0.5, 22 / Math.max(30, band.carryYd * YD));   // at least ~22 m either side
    const half = Math.max((band.toRad - band.fromRad) / 2 + 0.04, halfMin);
    const c0 = -Math.PI / 2 + midB - half, c1 = -Math.PI / 2 + midB + half;
    const r0 = band.minYd * YD * s, r1 = band.maxYd * YD * s, rc = band.carryYd * YD * s;
    ctx.beginPath();
    ctx.arc(ox, oy, r1, c0, c1);
    ctx.arc(ox, oy, r0, c1, c0, true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,210,31,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,210,31,0.6)'; ctx.lineWidth = 1.2 * ui;
    for (const r of [r0, r1]) { ctx.beginPath(); ctx.arc(ox, oy, r, c0, c1); ctx.stroke(); }
    ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2.4 * ui;
    ctx.beginPath(); ctx.arc(ox, oy, rc, c0, c1); ctx.stroke();
    // edge yardages just past the right end of the band
    ctx.font = `800 ${10 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const at = (r, txt) => {
      const a = c1 + 0.02;
      const x = ox + Math.cos(a) * r + 4 * ui, y = oy + Math.sin(a) * r;
      ctx.lineWidth = 3 * ui; ctx.strokeStyle = 'rgba(10,14,11,0.85)'; ctx.strokeText(txt, x, y);
      ctx.fillStyle = '#ffd21f'; ctx.fillText(txt, x, y);
    };
    if (r1 - r0 > 46 * ui) { at(r0, `${Math.round(band.minYd)}`); at(r1, `${Math.round(band.maxYd)}`); }
  }

  // Front and back of the green on the line through the pin (yardages.mjs): a short tick
  // across the line at each, and the two yardages beside the green, front below back, on
  // whichever side is clear of the prediction's labels.
  _drawGreenMarks(ctx, view, w, h, ui, placed) {
    const g = this.marks && this.marks.green;
    if (!g || (this.pred && this.pred.isPutt) || view.near) return;   // round the green the green itself fills the map
    const [x0, y0] = view.toPx(g.front[0], g.front[1]);
    const [x1, y1] = view.toPx(g.back[0], g.back[1]);
    const L = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;   // across the line
    let left = Math.min(x0, x1), right = Math.max(x0, x1);
    for (const [x, y] of this.marks.greenPoly || []) {
      const X = view.toPx(x, y)[0];
      left = Math.min(left, X); right = Math.max(right, X);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 1.6 * ui;
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      ctx.beginPath(); ctx.moveTo(x - nx * 5 * ui, y - ny * 5 * ui); ctx.lineTo(x + nx * 5 * ui, y + ny * 5 * ui); ctx.stroke();
    }
    ctx.font = `800 ${9.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const th = 12 * ui;
    const front = `${Math.round(g.frontYd)}`, back = `${Math.round(g.backYd)}`;
    const tw = Math.max(ctx.measureText(front).width, ctx.measureText(back).width);
    let yf = y0, yb = y1;   // the front sits lower on the map; keep the two a line apart
    if (yf - yb < th) { const c = (yf + yb) / 2; yf = c + th / 2; yb = c - th / 2; }
    const sides = [{ tx: right + 6 * ui, align: 'left' }, { tx: left - 6 * ui, align: 'right' }];
    const boxesAt = ({ tx, align }) => [yf, yb].map((y) => ({ x: (align === 'left' ? tx : tx - tw) - 2, y: y - th / 2, w: tw + 4, h: th }));
    const clear = (sd) => boxesAt(sd).every((b) => b.x > 2 && b.x + b.w < w - 2
      && !placed.some((q) => b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h));
    const side = sides.find(clear) || sides[0];
    ctx.textAlign = side.align;
    for (const [txt, y] of [[front, yf], [back, yb]]) {
      ctx.lineWidth = 3 * ui; ctx.strokeStyle = 'rgba(10,14,11,0.85)'; ctx.strokeText(txt, side.tx, y);
      ctx.fillStyle = '#ffffff'; ctx.fillText(txt, side.tx, y);
    }
    placed.push(...boxesAt(side));
    ctx.restore();
  }

  // Front and back of the hazards this shot can find (yardages.mjs hazardsInPlay, the
  // ones the 3D view tags), the way a yardage book marks them: a thin bracket down the
  // hazard's outer side from its front to its back, and the two numbers beside it, clear
  // of the labels already placed. None round the green, where the green fills the map.
  _drawHazards(ctx, view, w, h, ui, placed) {
    const list = view.near ? [] : hazardsInPlay(this.marks, this.pred);
    if (!list.length) return;
    ctx.save();
    ctx.font = `800 ${9.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const th = 12 * ui;
    for (const hz of list) {
      const yF = view.toPx(hz.front[0], hz.front[1])[1], yB = view.toPx(hz.back[0], hz.back[1])[1];
      // a carry over water the line crosses is bracketed just right of the line
      const edge = hz.onLine ? view.ox + 10 * ui : view.ox + (hz.side > 0 ? hz.uMax : hz.uMin) * view.s + hz.side * 3 * ui;
      const txt = hazardText(hz);
      const tw = ctx.measureText(txt).width;
      const tx = hz.side > 0 ? edge + 4 * ui : edge - 4 * ui - tw;
      // beside the middle of its bracket, or a line above or below when a target or an
      // earlier label is there
      let ty = (yF + yB) / 2, box = null;
      for (const k of [0, -1, 1, -2, 2]) {
        const y = ty + k * (th + 3 * ui);
        const b = { x: tx - 2, y: y - th / 2, w: tw + 4, h: th };
        if (b.x < 2 || b.x + b.w > w - 2 || b.y < 2 || b.y + b.h > h - 2) continue;
        if (placed.some((q) => b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h)) continue;
        box = b; ty = y; break;
      }
      if (!box) continue;
      placed.push(box);
      const col = hz.kind === 'water' ? '#bfe2ff' : '#f0e2b8';
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = col; ctx.lineWidth = 1 * ui;
      ctx.beginPath();
      ctx.moveTo(edge - hz.side * 2.5 * ui, yF); ctx.lineTo(edge, yF); ctx.lineTo(edge, yB); ctx.lineTo(edge - hz.side * 2.5 * ui, yB);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.lineWidth = 3 * ui; ctx.strokeStyle = 'rgba(10,14,11,0.85)'; ctx.strokeText(txt, tx, ty);
      ctx.fillStyle = col; ctx.fillText(txt, tx, ty);
    }
    ctx.restore();
  }

  // The aim: a line from the ball, solid out to a target ring at the club's carry (the
  // pin's distance without a prediction) and faint beyond, the target labelled with how
  // far left or right of the pin it is. While the pointer is over the map, a ghost line
  // shows where a click would aim.
  _drawAim(ctx, view, w, h, ui) {
    const { ox, oy, s } = view;
    const L = Math.hypot(w, h);
    ctx.save();
    if (this._hover != null && !this._dragging && !this._planDrag && this._hover !== this.aimOffset) {
      const b = this._hover * DEG;
      ctx.setLineDash([2 * ui, 5 * ui]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.1 * ui;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.sin(b) * L, oy - Math.cos(b) * L); ctx.stroke();
      ctx.setLineDash([]);
    }
    // a full shot's plan carries the target (_drawPlan): no aim ring of its own
    if (this._planFor(view)) { ctx.restore(); return null; }
    const a = this.aimOffset * DEG;
    const dYd = this.pred && !this.pred.isPutt && this.pred.carryYd > 0 ? this.pred.carryYd : this._pinYd();
    const R = dYd * YD * s;
    const tx = ox + Math.sin(a) * R, ty = oy - Math.cos(a) * R;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.6 * ui;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(tx - Math.sin(a) * 9 * ui, ty + Math.cos(a) * 9 * ui); ctx.stroke();
    ctx.setLineDash([5 * ui, 6 * ui]);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.1 * ui;
    ctx.beginPath(); ctx.moveTo(tx + Math.sin(a) * 9 * ui, ty - Math.cos(a) * 9 * ui); ctx.lineTo(ox + Math.sin(a) * L, oy - Math.cos(a) * L); ctx.stroke();
    ctx.setLineDash([]);
    // the target: a ring with four ticks, and how far off the pin it is, on its left
    // (the prediction's labels go on the right)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 * ui;
    ctx.beginPath(); ctx.arc(tx, ty, 7 * ui, 0, Math.PI * 2); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath(); ctx.moveTo(tx + dx * 4 * ui, ty + dy * 4 * ui); ctx.lineTo(tx + dx * 11 * ui, ty + dy * 11 * ui); ctx.stroke();
    }
    const yd = Math.round(Math.abs(Math.tan(a) * dYd));
    // AUTO's aim in effect: the safe spot it aims for, marked
    const auto = this.auto && !this._dragging ? this.auto : null;
    if (auto) {
      const [sx, sy] = view.toPx(auto.x, auto.y);
      ctx.beginPath();
      ctx.moveTo(sx, sy - 6 * ui); ctx.lineTo(sx + 6 * ui, sy); ctx.lineTo(sx, sy + 6 * ui); ctx.lineTo(sx - 6 * ui, sy); ctx.closePath();
      ctx.fillStyle = 'rgba(69,212,131,0.35)'; ctx.fill();
      ctx.strokeStyle = '#45d483'; ctx.lineWidth = 1.6 * ui; ctx.stroke();
    }
    const txt = auto ? `AUTO · ${auto.kind === 'green' ? 'GREEN' : auto.kind === 'fairway' ? 'FAIRWAY' : 'LINE'}`
      : yd ? `AIM ${yd} ${a > 0 ? 'R' : 'L'}` : 'AIM PIN';
    ctx.font = `800 ${10 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    const tw = ctx.measureText(txt).width + 10 * ui, th = 16 * ui;
    const bx = Math.max(4 * ui, tx - 15 * ui - tw), by = ty - th / 2;
    ctx.fillStyle = 'rgba(16,18,21,0.9)';
    ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 5 * ui); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + 5 * ui, ty + 0.5);
    ctx.restore();
    return { x: bx, y: by, w: tw, h: th };
  }

  // the pin's distance from the ball (yd)
  _pinYd() {
    const { ball, pin } = this.hole;
    return Math.hypot(pin[0] - ball.x, pin[1] - ball.y) / YD;
  }

  _path(ctx, view, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => { const [X, Y] = view.toPx(p.x, p.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  }

  // Draws the prediction; returns the boxes of its two labels.
  _drawPrediction(ctx, view, ui) {
    const p = this.pred;
    const boxes = [];
    if (!p || !p.path || p.path.length < 2) return boxes;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // calm-air ghost: where the same swing goes on a still, standard day
    const std = p.standard && p.standard.path;
    if (std && std.length > 1 && Math.abs((p.standard.carryYd ?? 0) - p.carryYd) + Math.abs((p.standard.offlineYd ?? 0) - p.offlineYd) > 1.5) {
      const sFlight = std.filter((q) => q.t <= (p.standard.flightTime ?? p.flightTime) + 1e-6);
      ctx.setLineDash([3 * ui, 4 * ui]);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.3 * ui;
      this._path(ctx, view, sFlight.length > 1 ? sFlight : std); ctx.stroke();
      ctx.setLineDash([]);
    }
    // dispersion: where ~95 % of these swings land, and where they stop
    const ring = (pts, fill, stroke, dash) => {
      if (!pts || pts.length < 3) return;
      this._path(ctx, view, pts); ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.setLineDash(dash || []); ctx.strokeStyle = stroke; ctx.lineWidth = 1.1 * ui; ctx.stroke(); ctx.setLineDash([]); }
    };
    const plan = this._planFor(view);
    // (a plan's target crosshair stands for both: two markers, the target and the pin)
    if (p.dispersion && !plan) {
      ring(p.dispersion.rest, null, 'rgba(255,255,255,0.35)', [3 * ui, 3 * ui]);
      ring(p.dispersion.land, 'rgba(255,210,31,0.17)', 'rgba(255,210,31,0.65)');
    }
    const ft = p.flightTime ?? Infinity;
    const flight = p.path.filter((q) => q.t <= ft + 1e-6);
    const roll = p.path.filter((q) => q.t >= ft - 1e-6);
    ctx.shadowColor = 'rgba(255,196,0,0.55)'; ctx.shadowBlur = 6 * ui;
    ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2.6 * ui;
    this._path(ctx, view, flight); ctx.stroke();
    ctx.shadowBlur = 0;
    if (roll.length > 1) {
      ctx.setLineDash([1 * ui, 4.5 * ui]); ctx.lineWidth = 2.4 * ui;
      this._path(ctx, view, roll); ctx.stroke(); ctx.setLineDash([]);
    }
    // landing and resting markers with their yardages
    const label = (X, Y, txt, gold) => {
      ctx.font = `800 ${11.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(txt).width + 10 * ui, th = 17 * ui;
      const bx = X + 9 * ui, by = Y - th / 2;
      boxes.push({ x: bx, y: by, w: tw, h: th });
      ctx.fillStyle = gold ? '#ffd21f' : 'rgba(16,18,21,0.88)';
      ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 5 * ui); ctx.fill();
      if (!gold) { ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = gold ? '#15130a' : '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 5 * ui, Y + 0.5);
    };
    if (p.land && !plan) {
      const [X, Y] = view.toPx(p.land.x, p.land.y);
      ctx.beginPath(); ctx.arc(X, Y, 5 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#15130a'; ctx.fill(); ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2.2 * ui; ctx.stroke();
      label(X, Y, `${Math.round(p.carryYd)}`, true);
    }
    const legs = p.rest && !p.isPutt && !view.near;
    if (p.rest && !plan && p.totalYd - p.carryYd > 3) {
      const [X, Y] = view.toPx(p.rest.x, p.rest.y);
      ctx.beginPath(); ctx.arc(X, Y, 3.6 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#15130a'; ctx.lineWidth = 1.4 * ui; ctx.stroke();
      if (!legs) label(X - 2 * ui, Y - 15 * ui, `${Math.round(p.totalYd)}`, false);
    }
    if (plan) this._drawPlan(ctx, view, ui, plan, boxes);
    else if (legs) this._drawLegs(ctx, view, ui, p, boxes);
    ctx.restore();
    return boxes;
  }

  // The plan (shot-plan.mjs): this shot's leg is its gold flight; the legs after it thin
  // white lines, target to target to the pin; a crosshair at each target; a bubble of
  // its length beside each leg. Remembers where the lay-up is drawn, to be dragged.
  _drawPlan(ctx, view, ui, plan, boxes) {
    const px = (q) => view.toPx(q.x, q.y);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 3 * ui;
    plan.legs.forEach((leg, i) => {
      if (i === 0) return;
      const A = px(leg.from), Z = px(leg.to);
      ctx.strokeStyle = 'rgba(255,255,255,0.82)'; ctx.lineWidth = 1.5 * ui;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(Z[0], Z[1]); ctx.stroke();
    });
    ctx.shadowBlur = 0;
    this._layupPx = null;
    plan.targets.forEach((t, i) => {
      const [X, Y] = px(t);
      const R = i === 0 ? 10.5 * ui : 9 * ui;
      this._crosshair(ctx, X, Y, ui, R, t.kind === 'layup' && this._planDrag);
      if (t.kind === 'layup') this._layupPx = [X, Y];
      boxes.push({ x: X - R - 3 * ui, y: Y - R - 3 * ui, w: 2 * R + 6 * ui, h: 2 * R + 6 * ui });   // the hazards' labels keep off it
    });
    for (const leg of plan.legs) this._bubble(ctx, ui, px(leg.from), px(leg.to), leg.yd, boxes);
    ctx.restore();
  }

  // A target, as a GPS card marks one: a ring with four ticks in toward a centre dot.
  _crosshair(ctx, X, Y, ui, R, held = false) {
    ctx.save();
    ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2);
    ctx.fillStyle = held ? 'rgba(255,255,255,0.22)' : 'rgba(10,12,14,0.3)'; ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3 * ui;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * ui; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4 * ui; ctx.lineCap = 'round';
    for (const k of [1, 3, 5, 7]) {
      const a = (k * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(X + Math.cos(a) * R * 0.45, Y + Math.sin(a) * R * 0.45);
      ctx.lineTo(X + Math.cos(a) * R * 0.95, Y + Math.sin(a) * R * 0.95);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(X, Y, 1.9 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
  }

  // The shot in two legs, as a GPS card breaks it down: how far this one goes (ball to
  // where it stops) and what it leaves to the pin, each in a quiet round bubble beside
  // its leg, the second leg a faint line on to the pin. Pushes the bubbles' boxes.
  _drawLegs(ctx, view, ui, p, boxes) {
    const { ball, pin } = this.hole;
    const B = view.toPx(ball.x, ball.y), R = view.toPx(p.rest.x, p.rest.y), P = view.toPx(pin[0], pin[1]);
    const leftYd = Math.hypot(pin[0] - p.rest.x, pin[1] - p.rest.y) / YD;
    if (leftYd >= 15) {
      ctx.setLineDash([2 * ui, 4 * ui]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2 * ui;
      ctx.beginPath(); ctx.moveTo(R[0], R[1]); ctx.lineTo(P[0], P[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
    this._bubble(ctx, ui, B, R, p.totalYd, boxes);
    if (leftYd >= 15) this._bubble(ctx, ui, R, P, leftYd, boxes);
  }

  // A leg's length in a quiet round bubble beside its middle, on its left (the stop's and
  // the hazards' labels go right). Pushes the bubble's box.
  _bubble(ctx, ui, A, Z, yd, boxes) {
    const L = Math.hypot(Z[0] - A[0], Z[1] - A[1]);
    if (L < 40 * ui) return;   // too short a leg to sit beside
    const nx = (Z[1] - A[1]) / L, ny = -(Z[0] - A[0]) / L;
    const num = `${Math.round(yd)}`;
    ctx.save();
    ctx.font = `800 ${11 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    const tw = ctx.measureText(num).width;
    ctx.font = `700 ${7.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    const uw = ctx.measureText('y').width;
    const r = Math.max(13 * ui, (tw + uw) / 2 + 5 * ui);
    const X = (A[0] + Z[0]) / 2 + nx * (r + 8 * ui), Y = (A[1] + Z[1]) / 2 + ny * (r + 8 * ui);
    ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14,16,18,0.78)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const x0 = X - (tw + uw) / 2, base = Y + 4 * ui;
    ctx.font = `800 ${11 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.fillText(num, x0, base);
    ctx.font = `700 ${7.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('y', x0 + tw + 0.5 * ui, base);
    ctx.restore();
    boxes.push({ x: X - r, y: Y - r, w: 2 * r, h: 2 * r });
  }

  _drawShot(ctx, view, ui) {
    if (!this.shot) return;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4 * ui;
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3 * ui;
    this._path(ctx, view, this.shot); ctx.stroke();
    const last = this.shot[this.shot.length - 1];
    const [X, Y] = view.toPx(last.x, last.y);
    ctx.beginPath(); ctx.arc(X, Y, 4 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
  }

  _drawPinBall(ctx, view, ui) {
    const { pin, ball } = this.hole;
    const [px, py] = view.toPx(pin[0], pin[1]);
    ctx.save();
    if (view.near) {
      // round the green: the cup ringed so it can't be missed, with how far it is
      ctx.beginPath(); ctx.arc(px, py, 9 * ui, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.4 * ui; ctx.stroke();
      const ft = Math.round(Math.hypot(pin[0] - ball.x, pin[1] - ball.y) / FT);
      const txt = `${ft} ft`;
      ctx.font = `800 ${11.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(txt).width + 10 * ui, th = 17 * ui;
      const bx = px + 13 * ui, by = py - 17 * ui - th / 2;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 5 * ui); ctx.fill();
      ctx.fillStyle = '#15130a'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 5 * ui, by + th / 2 + 0.5);
    }
    // flag: pole and pennant, with a ring for the cup
    ctx.beginPath(); ctx.arc(px, py, 4 * ui, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.3 * ui; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * ui;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 17 * ui); ctx.stroke();
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath(); ctx.moveTo(px, py - 17 * ui); ctx.lineTo(px + 11 * ui, py - 13 * ui); ctx.lineTo(px, py - 9 * ui); ctx.closePath(); ctx.fill();
    const [bx, by] = view.toPx(ball.x, ball.y);
    ctx.beginPath(); ctx.arc(bx, by, 5 * ui, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.strokeStyle = '#15130a'; ctx.lineWidth = 2 * ui; ctx.stroke();
    ctx.restore();
  }

  // wind: an arrow in the map's own frame (up = the default line) with its speed
  _drawWind(ctx, w, h, ui, view) {
    const wd = this.wind;
    if (!wd || !(wd.mph > 0.5)) return;
    const cx = 26 * ui, cy = 26 * ui, r = 17 * ui;
    const rel = (wd.fromDeg + 180 - this.hole.baseAimDeg) * DEG;   // direction it blows toward, map frame
    ctx.save();
    ctx.fillStyle = 'rgba(12,15,13,0.8)';
    ctx.beginPath(); ctx.arc(cx, cy, r + 4 * ui, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.translate(cx, cy); ctx.rotate(rel);
    ctx.strokeStyle = '#ffd21f'; ctx.fillStyle = '#ffd21f'; ctx.lineWidth = 2.4 * ui; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, r * 0.75); ctx.lineTo(0, -r * 0.45); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-5.5 * ui, -r * 0.3); ctx.lineTo(0, -r * 0.85); ctx.lineTo(5.5 * ui, -r * 0.3); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.font = `800 ${11 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * ui; ctx.strokeStyle = 'rgba(10,14,11,0.85)';
    const txt = `${Math.round(wd.mph)} mph${wd.gustMph ? ` · G${Math.round(wd.mph + wd.gustMph)}` : ''}`;
    ctx.strokeText(txt, cx + r + 9 * ui, cy); ctx.fillStyle = '#fff'; ctx.fillText(txt, cx + r + 9 * ui, cy);
    ctx.restore();
  }

  // ---- click / drag to aim; drag the lay-up target to plan the next shot ----
  _bind() {
    const local = (e) => { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const onLayup = (e) => {
      if (!this._layupPx || !this.onPlan) return false;
      const [x, y] = local(e);
      return Math.hypot(x - this._layupPx[0], y - this._layupPx[1]) <= 16;
    };
    // the pointer in sim metres (the view's transform turned back)
    const toSim = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const view = this._view(r.width, r.height);
      const [x, y] = local(e);
      const u = (x - view.ox) / view.s, v = (view.oy - y) / view.s;
      const { ball } = this.hole;
      return { x: ball.x + u * view.right[0] + v * view.fwd[0], y: ball.y + u * view.right[1] + v * view.fwd[1] };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!onLayup(e)) return;
      this._planDrag = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
      e.stopImmediatePropagation();
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this._planDrag) { this.onPlan?.(toSim(e)); return; }
      if (e.pointerType !== 'touch' && !this._dragging) this.canvas.style.cursor = onLayup(e) ? 'grab' : '';
    });
    const endPlan = (e) => {
      if (!this._planDrag) return;
      this._planDrag = false;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.canvas.style.cursor = '';
      this.draw();
    };
    this.canvas.addEventListener('pointerup', endPlan);
    this.canvas.addEventListener('pointercancel', endPlan);
    const toOffset = (e) => {
      if (!this.hole) return null;
      const r = this.canvas.getBoundingClientRect();
      const view = this._view(r.width, r.height);
      const x = e.clientX - r.left - view.ox, y = view.oy - (e.clientY - r.top);
      if (y < 4) return null;
      return clamp(Math.round(Math.atan2(x, y) / DEG * 2) / 2, -30, 30);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this._planDrag) return;
      const off = toOffset(e);
      if (off == null) return;
      this._dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.aimOffset = off; this.draw();
      this.onAim?.(off);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const off = toOffset(e);
      if (off == null || off === this.aimOffset) return;
      this.aimOffset = off; this.draw();
      this.onAim?.(off);
    });
    const end = (e) => {
      if (!this._dragging) return;
      this._dragging = false;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.onAimEnd?.(this.aimOffset);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    // a ghost line where a click would aim, and a double-click back at the pin
    this.canvas.addEventListener('pointermove', (e) => {
      if (this._dragging || this._planDrag || e.pointerType === 'touch') return;
      const off = toOffset(e);
      if (off === this._hover) return;
      this._hover = off; this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => { if (this._hover != null) { this._hover = null; this.draw(); } });
    this.canvas.addEventListener('dblclick', () => {
      this.aimOffset = 0; this._hover = null; this.draw();
      this.onAimEnd?.(0);
    });
  }
}
