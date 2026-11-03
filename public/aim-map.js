// Overhead aim map: the hole from above, turned so the default line of play points up,
// with yardage arcs from the ball, the club's predicted flight (gold) and roll (dotted),
// the ~2-sigma landing and resting areas, the calm-air flight as a faint ghost (the
// gap between the two is what the wind is doing), the pin, the wind, and the live shot.
// Click or drag on it to aim.
//
// Sim coordinates: metres, x east, y north. Compass headings clockwise from north.
const YD = 0.9144;
const DEG = Math.PI / 180;

// map palette: a dark course plan the gold prediction and white arcs read on
const PAL = {
  rough: '#1d2b1f', roughEdge: '#223324',
  fairway: '#3a6a37', tee: '#3f7139', range: '#355f33',
  green: '#5aa64c', bunker: '#d6c495', water: '#2c6c9e', waterEdge: '#4a8fc4',
  tree: 'rgba(8, 18, 10, 0.78)', treeHi: 'rgba(40, 70, 40, 0.55)',
};
const Z = { rough: 0, range: 1, fairway: 1, tee: 2, green: 3, bunker: 4, water: 4 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class AimMap {
  constructor(canvas, { onAim = null, onAimEnd = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onAim = onAim;
    this.onAimEnd = onAimEnd;
    this.geo = null;
    this.hole = null;        // { ball: {x,y}, pin: [x,y], baseAimDeg, line }
    this.aimOffset = 0;
    this.pred = null;
    this.wind = null;        // { mph, fromDeg }
    this.shot = null;        // live / last shot points [{x,y,z,t}]
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
  setPrediction(pred) { this.pred = pred; this.draw(); }
  setWind(wind) { this.wind = wind; this.draw(); }
  setShot(points) { this.shot = points && points.length > 1 ? points : null; this.draw(); }

  // ---- view transform: ball near the bottom, default line straight up ----
  _view(Wc, Hc) {
    const { ball, pin, baseAimDeg } = this.hole;
    const a = baseAimDeg * DEG;
    const fwd = [Math.sin(a), Math.cos(a)], right = [Math.cos(a), -Math.sin(a)];
    const toUV = (x, y) => {
      const dx = x - ball.x, dy = y - ball.y;
      return [dx * right[0] + dy * right[1], dx * fwd[0] + dy * fwd[1]];
    };
    const [pu, pv] = toUV(pin[0], pin[1]);
    let reach = Math.max(pv + 22, 70);
    let half = Math.max(Math.abs(pu) + 22, 42);
    if (this.pred && this.pred.rest && !this.pred.isPutt) {
      const [ru, rv] = toUV(this.pred.rest.x, this.pred.rest.y);
      reach = Math.max(reach, rv + 30);
      half = Math.max(half, Math.abs(ru) + 26);
    }
    const padTop = 18, padBot = 30;
    const s = Math.min((Hc - padTop - padBot) / reach, (Wc / 2 - 10) / half);
    const ox = Wc / 2, oy = Hc - padBot;
    const toPx = (x, y) => { const [u, v] = toUV(x, y); return [ox + u * s, oy - v * s]; };
    return { toUV, toPx, s, ox, oy, a, fwd, right };
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
    if (!this.hole || !this.geo || w < 20 || h < 20) return;
    const view = this._view(w, h);
    const key = `${W}x${H}|${this.hole.ball.x},${this.hole.ball.y}|${this.hole.baseAimDeg}|${view.s.toFixed(4)}`;
    if (key !== this._staticKey) { this._drawStatic(view, W, H, dpr, w, h); this._staticKey = key; }
    ctx.drawImage(this._static, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawArcs(ctx, view, w, h, ui);
    this._drawHazards(ctx, view, w, h, ui, key);
    this._drawAim(ctx, view, w, h, ui);
    this._drawPrediction(ctx, view, ui);
    this._drawShot(ctx, view, ui);
    this._drawPinBall(ctx, view, ui);
    this._drawWind(ctx, w, h, ui, view);
  }

  // course plan: surfaces, woods and tree canopies (cached per hole and size)
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
    const poly = (pts) => {
      ctx.beginPath();
      pts.forEach((p, i) => { const [X, Y] = view.toPx(p[0], p[1]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath();
    };
    const surfs = (this.geo.surfaces || []).filter((su) => PAL[su.kind] && su.poly && su.poly.length >= 3 && inView(su.poly))
      .sort((a, b) => (Z[a.kind] ?? 1) - (Z[b.kind] ?? 1));
    for (const su of surfs) {
      poly(su.poly);
      ctx.fillStyle = PAL[su.kind];
      ctx.fill();
      if (su.kind === 'water') { ctx.strokeStyle = PAL.waterEdge; ctx.lineWidth = 1; ctx.stroke(); }
      if (su.kind === 'green') { ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    // woods and lidar canopies: dark crowns with a lit rim toward the top of the map
    ctx.fillStyle = PAL.tree;
    for (const wd of this.geo.woods || []) {
      if (wd.length >= 3 && inView(wd)) { poly(wd); ctx.fill(); }
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
    // the hole's own line of play (doglegs), faint
    const line = this.hole.line;
    if (line && line.length > 1) {
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
      ctx.beginPath();
      line.forEach((p, i) => { const [X, Y] = view.toPx(p[0], p[1]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // yardage arcs every 50 y (25 y on short shots) from the ball, labelled on the right
  _drawArcs(ctx, view, w, h, ui) {
    const { ox, oy, s } = view;
    const maxM = Math.hypot(Math.max(ox, w - ox), oy) / s;
    const stepYd = maxM / YD > 260 ? 50 : maxM / YD > 110 ? 25 : 10;
    ctx.save();
    ctx.font = `700 ${10.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const band = this.pred && !this.pred.isPutt ? this.pred.band : null;
    const dim = band ? 0.6 : 1;   // the club's own lines lead; the yardage grid steps back
    for (let yd = stepYd; yd * YD < maxM; yd += stepYd) {
      const R = yd * YD * s;
      const major = yd % (stepYd * 2) === 0 || stepYd === 50;
      ctx.beginPath();
      ctx.arc(ox, oy, R, Math.PI * 1.08, Math.PI * 1.92);
      ctx.strokeStyle = major ? `rgba(255,255,255,${0.3 * dim})` : `rgba(255,255,255,${0.13 * dim})`;
      ctx.lineWidth = major ? 1.1 * ui : 0.8 * ui;
      ctx.stroke();
      if (!major) continue;
      // label where the arc leaves the right edge (or at 40 degrees right of the line)
      let ang = 40 * DEG;
      const xr = (w - ox - 22 * ui);
      if (R > xr) ang = Math.asin(xr / R);
      const lx = ox + Math.sin(ang) * R, ly = oy - Math.cos(ang) * R;
      if (ly < 10 || ly > h - 4) continue;
      const txt = `${yd}`;
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

  // Yardage-book numbers for the hazards near the line: front and back of each bunker
  // and the carry over water, from the ball, for the few that matter most to this club.
  _hazardList(view, key) {
    if (this._hazKey === key) return this._haz;
    const out = [];
    const pinV = view.toUV(this.hole.pin[0], this.hole.pin[1])[1];
    for (const su of this.geo.surfaces || []) {
      if ((su.kind !== 'bunker' && su.kind !== 'water') || !su.poly || su.poly.length < 3) continue;
      let front = Infinity, back = -Infinity, uMin = Infinity, uMax = -Infinity, ax = 0, ay = 0, n = 0;
      for (const [x, y] of su.poly) {
        const [u, v] = view.toUV(x, y);
        if (v < 35 || v > pinV + 25) continue;
        if (Math.abs(u) > 24 + 0.09 * v) continue;   // a corridor that widens with distance
        front = Math.min(front, v); back = Math.max(back, v);
        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
        ax += x; ay += y; n++;
      }
      if (!n || back - front < 2) continue;
      out.push({ kind: su.kind, front: front / YD, back: back / YD, u: (uMin + uMax) / 2, uMax, x: ax / n, y: ay / n });
    }
    this._haz = out;
    this._hazKey = key;
    return out;
  }

  _drawHazards(ctx, view, w, h, ui, key) {
    const list = this._hazardList(view, key);
    if (!list.length) return;
    const p = this.pred && !this.pred.isPutt ? this.pred : null;
    const focus = p ? p.carryYd : null;
    const ranked = [...list].sort((a, b) => (focus == null ? a.front - b.front : Math.abs((a.front + a.back) / 2 - focus) - Math.abs((b.front + b.back) / 2 - focus))).slice(0, 4);
    ctx.save();
    ctx.font = `800 ${9.5 * ui}px Bahnschrift, "DIN Alternate", Inter, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const hz of ranked) {
      const [X, Y] = view.toPx(hz.x, hz.y);
      const txt = hz.kind === 'water' ? `WATER ${Math.round(hz.front)}–${Math.round(hz.back)}` : `${Math.round(hz.front)}–${Math.round(hz.back)}`;
      const tw = ctx.measureText(txt).width + 9 * ui, th = 15 * ui;
      let bx = hz.u >= 0 ? X + 10 * ui : X - 10 * ui - tw, by = Y - th / 2;
      bx = Math.max(4, Math.min(w - tw - 4, bx));
      if (by < 4 || by > h - th - 4) continue;
      if (placed.some((q) => Math.abs(q.y - by) < th && Math.abs(q.x - bx) < Math.max(q.w, tw))) continue;
      placed.push({ x: bx, y: by, w: tw });
      ctx.fillStyle = hz.kind === 'water' ? 'rgba(18,52,82,0.92)' : 'rgba(16,18,21,0.86)';
      ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 4 * ui); ctx.fill();
      ctx.strokeStyle = hz.kind === 'water' ? 'rgba(110,180,240,0.7)' : 'rgba(233,216,166,0.55)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = hz.kind === 'water' ? '#bfe2ff' : '#f0e2b8';
      ctx.textAlign = 'left';
      ctx.fillText(txt, bx + 4.5 * ui, Y + 0.5);
    }
    ctx.restore();
  }

  _drawAim(ctx, view, w, h, ui) {
    const { ox, oy } = view;
    const a = this.aimOffset * DEG;
    const L = Math.hypot(w, h);
    ctx.save();
    ctx.setLineDash([6 * ui, 6 * ui]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.2 * ui;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + Math.sin(a) * L, oy - Math.cos(a) * L); ctx.stroke();
    ctx.restore();
  }

  _path(ctx, view, pts) {
    ctx.beginPath();
    pts.forEach((p, i) => { const [X, Y] = view.toPx(p.x, p.y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
  }

  _drawPrediction(ctx, view, ui) {
    const p = this.pred;
    if (!p || !p.path || p.path.length < 2) return;
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
    if (p.dispersion) {
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
      ctx.fillStyle = gold ? '#ffd21f' : 'rgba(16,18,21,0.88)';
      ctx.beginPath(); ctx.roundRect(bx, by, tw, th, 5 * ui); ctx.fill();
      if (!gold) { ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = gold ? '#15130a' : '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 5 * ui, Y + 0.5);
    };
    if (p.land) {
      const [X, Y] = view.toPx(p.land.x, p.land.y);
      ctx.beginPath(); ctx.arc(X, Y, 5 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#15130a'; ctx.fill(); ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = 2.2 * ui; ctx.stroke();
      label(X, Y, `${Math.round(p.carryYd)}`, true);
    }
    if (p.rest && p.totalYd - p.carryYd > 3) {
      const [X, Y] = view.toPx(p.rest.x, p.rest.y);
      ctx.beginPath(); ctx.arc(X, Y, 3.6 * ui, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#15130a'; ctx.lineWidth = 1.4 * ui; ctx.stroke();
      label(X - 2 * ui, Y - 15 * ui, `${Math.round(p.totalYd)}`, false);
    }
    ctx.restore();
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

  // ---- click / drag to aim ----
  _bind() {
    const toOffset = (e) => {
      if (!this.hole) return null;
      const r = this.canvas.getBoundingClientRect();
      const view = this._view(r.width, r.height);
      const x = e.clientX - r.left - view.ox, y = view.oy - (e.clientY - r.top);
      if (y < 4) return null;
      return clamp(Math.round(Math.atan2(x, y) / DEG * 2) / 2, -30, 30);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
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
  }
}
