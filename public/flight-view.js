// HUD side-view flight panel (OpenFlight's Flight view): the current shot drawn from
// the side (height ft vs distance yd) in sync with the 3D replay, with a faint grid, an
// "apex N ft" label, the landing point + carry, and earlier shots on this hole as ghost
// lines. While the player lines up, it shows the club's PREDICTED flight instead (gold,
// dashed) with the calm-air flight as a faint ghost; once the ball is struck the real
// shot draws over the prediction, so the two can be compared.
// Maths lives in render/flight-profile.js (unit-tested); this file only owns the SVG.
import { shotProfile, profileUpTo, sideViewScale, toPolyline, toAreaPolygon } from './render/flight-profile.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 360, H = 132;
const MARGINS = { ml: 30, mr: 12, mt: 16, mb: 20 };
const MAX_GHOSTS = 6;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

export class FlightView {
  constructor(root) {
    this.root = root;
    this.svg = root.querySelector('svg');
    this.title = root.querySelector('[data-fv=title]');
    this.stat = root.querySelector('[data-fv=stat]');
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.ghosts = [];      // completed profiles on this hole (oldest first)
    this.current = null;   // { profile, shot, scale }
    this.pred = null;      // { profile, std, carryYd, apexFt } for the club in hand
    this.holeKey = null;
    this._build();
  }

  _build() {
    const s = this.svg;
    s.textContent = '';
    this.gGrid = el('g', { class: 'fv-grid' }, s);
    this.gGhost = el('g', { class: 'fv-ghosts' }, s);
    this.stdLine = el('polyline', { class: 'fv-std', points: '' }, s);
    this.predArea = el('polygon', { class: 'fv-pred-area', points: '' }, s);
    this.predLine = el('polyline', { class: 'fv-pred', points: '' }, s);
    this.area = el('polygon', { class: 'fv-area', points: '' }, s);
    this.line = el('polyline', { class: 'fv-line', points: '' }, s);
    this.apexDrop = el('line', { class: 'fv-apex-drop', x1: -10, x2: -10, y1: 0, y2: 0 }, s);
    this.apexDot = el('circle', { class: 'fv-apex-dot', r: 3, cx: -10, cy: -10 }, s);
    this.apexText = el('text', { class: 'fv-apex-text', x: -10, y: -10, 'text-anchor': 'middle' }, s);
    this.landMark = el('path', { class: 'fv-land', d: '' }, s);
    this.landText = el('text', { class: 'fv-land-text', x: -10, y: -10, 'text-anchor': 'middle' }, s);
    this.ball = el('circle', { class: 'fv-ball', r: 4, cx: -10, cy: -10 }, s);
    this.ball.style.display = 'none';
  }

  // New hole: forget ghosts and hide until the first full shot.
  newHole(key) {
    if (key === this.holeKey) return;
    this.holeKey = key;
    this.ghosts = [];
    this.current = null;
    this.pred = null;
    this._clearPred();
    this._clearLive();
  }

  _clearLive() {
    this.line.setAttribute('points', '');
    this.area.setAttribute('points', '');
    this.ball.style.display = 'none';
    this.apexDot.style.display = this.apexDrop.style.display = this.apexText.style.display = 'none';
    this.landMark.style.display = this.landText.style.display = 'none';
    this.stat.textContent = '';
  }

  // The predicted flight for the club in hand (lib/predict.js), or null. Shown while no
  // shot is on screen; a struck shot keeps it as the dashed reference under the real one.
  showPrediction(pred) {
    const ok = pred && !pred.isPutt && pred.path && pred.path.length > 1;
    const profile = ok ? shotProfile(pred.path, { flightTime: pred.flightTime }) : null;
    if (!profile || profile.maxH < 1) {
      this.pred = null;
      if (!this.current) this._clearPred();
      return;
    }
    const sp = pred.standard && pred.standard.path;
    const differs = pred.standard && Math.abs((pred.standard.carryYd ?? pred.carryYd) - pred.carryYd) > 1.5;
    const std = sp && sp.length > 1 && differs ? shotProfile(sp, { flightTime: pred.standard.flightTime ?? null }) : null;
    this.pred = { profile, std, carryYd: pred.carryYd, apexFt: pred.apexFt };
    if (!this.current) this._drawPrediction();
  }

  _clearPred() {
    this.predLine.setAttribute('points', '');
    this.predArea.setAttribute('points', '');
    this.stdLine.setAttribute('points', '');
  }

  _drawPrediction() {
    const p = this.pred;
    if (!p) return;
    const scale = sideViewScale([p.profile, p.std, ...this.ghosts], { width: W, height: H, ...MARGINS });
    this._drawFrame(scale);
    this.line.setAttribute('points', '');
    this.area.setAttribute('points', '');
    this.ball.style.display = 'none';
    const flight = p.profile.landing ? profileUpTo(p.profile, p.profile.landing.t) : p.profile.pts;
    this.predLine.setAttribute('points', toPolyline(p.profile.pts, scale));
    this.predArea.setAttribute('points', toAreaPolygon(flight, scale));
    this.stdLine.setAttribute('points', p.std ? toPolyline(p.std.pts, scale) : '');
    this._markers(p.profile, scale, Math.round(p.apexFt ?? p.profile.apex?.h ?? 0), Math.round(p.carryYd), Infinity);
    this.title.textContent = 'PREDICTED FLIGHT';
    this.stat.textContent = `carry ${Math.round(p.carryYd)} yd · apex ${Math.round(p.apexFt ?? p.profile.maxH)} ft`;
  }

  // A shot was struck. Putts aren't drawn (a flat line along the ground says nothing).
  startShot(shot) {
    if (this.current) this._retire();
    const sim = shot && shot.sim;
    if (!sim || sim.isPutt || !sim.points || sim.points.length < 2) {
      this.current = null;
      return;
    }
    const profile = shotProfile(sim.points, { flightTime: sim.flightTime });
    if (!profile || profile.maxH < 1) { this.current = null; return; }
    const ref = this.pred ? this.pred.profile : null;
    const scale = sideViewScale([profile, ref, ...this.ghosts], { width: W, height: H, ...MARGINS });
    this.current = { profile, shot, scale, n: shot.strokes };
    this.root.classList.remove('hidden');
    this._drawFrame(scale);
    this.stdLine.setAttribute('points', '');
    this.predArea.setAttribute('points', '');
    this.predLine.setAttribute('points', ref ? toPolyline(ref.pts, scale) : '');
    this.title.textContent = Number.isFinite(shot.strokes) ? `SHOT ${shot.strokes} · SIDE VIEW` : 'SIDE VIEW';
    this.setTime(0);
  }

  // Draw the current shot up to sim time t (seconds since impact).
  setTime(t) {
    const cur = this.current;
    if (!cur) return;
    const { profile, scale } = cur;
    const pts = profileUpTo(profile, t);
    this.line.setAttribute('points', toPolyline(pts, scale));
    this.area.setAttribute('points', toAreaPolygon(pts, scale));
    const head = pts[pts.length - 1];
    this.ball.style.display = '';
    this.ball.setAttribute('cx', scale.sx(head.d).toFixed(1));
    this.ball.setAttribute('cy', scale.sy(head.h).toFixed(1));

    const { apexShown, landed } = this._markers(profile, scale, Math.round(cur.shot.sim.apexFt ?? profile.apex?.h ?? 0), Math.round(cur.shot.sim.carryYd), head.t);
    const carry = landed ? `carry ${Math.round(cur.shot.sim.carryYd)} yd · ` : '';
    this.stat.textContent = apexShown || landed ? `${carry}apex ${Math.round(cur.shot.sim.apexFt)} ft` : '';
  }

  // Apex dot + drop line + "apex N ft", and the landing diamond + "carry N yd", for a
  // profile drawn up to time t.
  _markers(profile, scale, apexFt, carryYd, t) {
    const apex = profile.apex;
    const apexShown = !!apex && t >= apex.t;
    if (apexShown) {
      const ax = scale.sx(apex.d), ay = scale.sy(apex.h);
      this.apexDot.setAttribute('cx', ax.toFixed(1)); this.apexDot.setAttribute('cy', ay.toFixed(1));
      this.apexDrop.setAttribute('x1', ax.toFixed(1)); this.apexDrop.setAttribute('x2', ax.toFixed(1));
      this.apexDrop.setAttribute('y1', (ay + 4).toFixed(1)); this.apexDrop.setAttribute('y2', scale.sy(Math.max(scale.minH, 0)).toFixed(1));
      this.apexText.setAttribute('x', Math.min(Math.max(ax, 40), W - 40).toFixed(1));
      this.apexText.setAttribute('y', (ay - 7).toFixed(1));
      this.apexText.textContent = `apex ${apexFt} ft`;
    }
    this.apexDot.style.display = this.apexDrop.style.display = this.apexText.style.display = apexShown ? '' : 'none';
    const land = profile.landing;
    const landed = !!land && t >= land.t - 1e-6;
    if (landed) {
      const lx = scale.sx(land.d), ly = scale.sy(land.h);
      this.landMark.setAttribute('d', `M${(lx - 4).toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${(ly - 4).toFixed(1)} L${(lx + 4).toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${(ly + 4).toFixed(1)} Z`);
      this.landText.setAttribute('x', Math.min(Math.max(lx, 44), W - 44).toFixed(1));
      this.landText.setAttribute('y', (ly - 9).toFixed(1));
      this.landText.textContent = `carry ${carryYd} yd`;
    }
    this.landMark.style.display = this.landText.style.display = landed ? '' : 'none';
    // Keep the carry label from colliding with the apex label on short, high shots.
    if (landed && apexShown) {
      const dx = Math.abs(Number(this.landText.getAttribute('x')) - Number(this.apexText.getAttribute('x')));
      const dy = Math.abs(Number(this.landText.getAttribute('y')) - Number(this.apexText.getAttribute('y')));
      if (dx < 70 && dy < 14) this.landText.setAttribute('y', (Number(this.apexText.getAttribute('y')) + 14).toFixed(1));
    }
    return { apexShown, landed };
  }

  // Back to lining up: the shot just played becomes a ghost, the prediction returns.
  lineup() {
    if (this.current) this._retire();
    this._clearLive();
    if (this.pred) this._drawPrediction();
    else this._clearPred();
  }

  get showingShot() { return !!this.current; }

  // Shot replay finished: keep it drawn (complete) until the next shot.
  finish() {
    if (this.current) this.setTime(Infinity);
  }

  _retire() {
    this.ghosts.push(this.current.profile);
    if (this.ghosts.length > MAX_GHOSTS) this.ghosts.shift();
    this.current = null;
  }

  _drawFrame(scale) {
    this.gGrid.textContent = '';
    for (const d of scale.dTicks) {
      el('line', { class: 'fv-gl', x1: scale.sx(d), x2: scale.sx(d), y1: scale.mt, y2: H - scale.mb }, this.gGrid);
      if (d > 0) {
        const tx = el('text', { class: 'fv-tick', x: scale.sx(d), y: H - scale.mb + 13, 'text-anchor': 'middle' }, this.gGrid);
        tx.textContent = d;
      }
    }
    for (const h of scale.hTicks) {
      el('line', { class: h === 0 ? 'fv-gl fv-base' : 'fv-gl', x1: scale.ml, x2: W - scale.mr, y1: scale.sy(h), y2: scale.sy(h) }, this.gGrid);
      if (h !== scale.minH || h === 0) {
        const ty = el('text', { class: 'fv-tick', x: scale.ml - 5, y: scale.sy(h) + 3, 'text-anchor': 'end' }, this.gGrid);
        ty.textContent = h;
      }
    }
    const unitD = el('text', { class: 'fv-unit', x: scale.ml, y: H - scale.mb + 13, 'text-anchor': 'middle' }, this.gGrid);
    unitD.textContent = 'yd';
    const unitH = el('text', { class: 'fv-unit', x: 4, y: scale.mt - 5 }, this.gGrid);
    unitH.textContent = 'ft';
    this.gGhost.textContent = '';
    for (const g of this.ghosts) {
      el('polyline', { class: 'fv-ghost', points: toPolyline(g.pts, scale) }, this.gGhost);
    }
  }
}
