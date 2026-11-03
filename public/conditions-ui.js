// Course conditions in the HUD: the wind dial on the left (always visible: how hard,
// and which way relative to the line of play), and the editor panel (presets, a wind
// compass you drag, temperature / altitude / humidity / firmness / green speed) with
// the measured effect of each on the shot in hand. The server owns the conditions
// (lib/conditions.js): every change is POSTed and comes back on the state stream, and
// the shot prediction is re-run with it.
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

export const firmnessLabel = (f) => (f < 0.2 ? 'Soft' : f < 0.4 ? 'Receptive' : f < 0.6 ? 'Normal' : f < 0.82 ? 'Firm' : 'Baked');

// Where the wind comes from relative to the line of play: rel = 0 means it blows
// straight at the golfer (into), 180 behind (helping), +90 from the right (R to L).
export function windWords(mph, fromDeg, aimDeg) {
  if (!(mph >= 1)) return { short: 'Calm', long: 'No wind' };
  const rel = ((fromDeg - aimDeg) % 360 + 540) % 360 - 180;
  const head = Math.cos(rel * DEG), cross = Math.sin(rel * DEG);
  const along = head > 0.38 ? 'Into' : head < -0.38 ? 'Helping' : '';
  const side = cross > 0.38 ? 'R→L' : cross < -0.38 ? 'L→R' : '';
  const short = [along, side].filter(Boolean).join(' · ') || 'Cross';
  const long = along && side ? `${along === 'Into' ? 'Into the wind' : 'Downwind'}, ${side === 'R→L' ? 'right to left' : 'left to right'}`
    : along ? (along === 'Into' ? 'Straight into the wind' : 'Straight downwind')
    : side === 'R→L' ? 'Right to left' : 'Left to right';
  return { short, long, rel };
}

const signed = (v, unit = 'yd') => {
  if (!Number.isFinite(v)) return '–';
  const r = Math.round(v);
  return r === 0 ? `0 ${unit}` : `${r > 0 ? '+' : '−'}${Math.abs(r)} ${unit}`;
};

export class ConditionsUI {
  constructor({ onOpen = null } = {}) {
    this.c = null;            // conditions from the server
    this.presets = [];
    this.aimDeg = 0;          // default line of play (compass), for the relative wind
    this.onOpen = onOpen;
    this._postT = null;
    this._pending = {};
    this._buildCompass();
    this._bindSliders();
    $('cond-widget').onclick = () => this.toggle();
    this.load();
  }

  async load() {
    try {
      const r = await fetch('/api/conditions');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      this.presets = j.presets || [];
      this._renderPresets();
      if (j.conditions) this.setConditions(j.conditions);
      this.available = true;
    } catch {
      this.available = false;   // a server without conditions: the dial just reads calm
      this.setConditions(null);
    }
  }

  get isOpen() { return !$('conditions').classList.contains('hidden'); }
  toggle(force) {
    const open = force ?? !this.isOpen;
    $('conditions').classList.toggle('hidden', !open);
    if (open) { this.onOpen?.(); this._renderCompass(); }
  }

  setAimDeg(aimDeg) {
    if (aimDeg === this.aimDeg) return;
    this.aimDeg = aimDeg;
    this._renderWidget();
    this._renderCompass();
  }

  // conditions from the state stream (or null: standard)
  setConditions(c) {
    // a slider being dragged keeps its own value until the server has caught up
    this.c = { windMph: 0, windFromDeg: 0, gustMph: 0, tempF: 70, altitudeFt: 0, humidity: 50, firmness: 0.5, greenStimp: 10.5, ...(c || {}), ...this._pending };
    this._renderWidget();
    this._renderSliders();
    this._renderCompass();
    document.querySelectorAll('#cond-presets .chip').forEach((b) => b.classList.toggle('active', !!c && b.dataset.id === c.presetId));
  }

  // the measured effect of each condition on the predicted shot (lib/predict.js effects)
  setEffects(pred) {
    const box = $('ce-effects');
    if (!pred || pred.isPutt || !pred.effects) {
      box.innerHTML = '<div class="muted" style="grid-column: 1 / -1; font-size: 12px">Pick a club to see how today\'s conditions move it.</div>';
      return;
    }
    const e = pred.effects, c = this.c;
    const ww = windWords(c.windMph, c.windFromDeg, this.aimDeg);
    const off = e.windOfflineYd;
    const tiles = [
      ['WIND', e.windCarryYd, c.windMph >= 1 ? `${ww.short}${Math.abs(off) >= 1 ? ` · ${Math.abs(Math.round(off))}${off > 0 ? 'R' : 'L'}` : ''}` : 'calm'],
      ['AIR', e.airCarryYd, `${Math.round(c.tempF)}°F · ${Math.round(c.altitudeFt).toLocaleString()} ft`],
      ['GROUND', e.firmnessRollYd, `${firmnessLabel(c.firmness)} fairways`],
      ['SLOPE', -(e.elevationYd ?? 0), Number.isFinite(pred.elevationFt) ? `${Math.abs(Math.round(pred.elevationFt))} ft ${pred.elevationFt >= 0 ? 'up' : 'down'}` : ''],
    ];
    box.innerHTML = tiles.map(([k, v, why]) => {
      const cls = !Number.isFinite(v) || Math.round(v) === 0 ? 'zero' : v > 0 ? 'pos' : 'neg';
      return `<div class="tile"><span class="lbl">${k}</span><b class="${cls}">${signed(v)}</b><span class="why">${why}</span></div>`;
    }).join('');
    $('ce-effects-title').textContent = `EFFECT ON THIS ${pred.clubName ? pred.clubName.toUpperCase() : 'SHOT'} (VS A STILL 70°F DAY)`;
  }

  _renderWidget() {
    const c = this.c || {};
    const mph = c.windMph || 0;
    const ww = windWords(mph, c.windFromDeg || 0, this.aimDeg);
    const w = $('cond-widget');
    w.classList.toggle('calm', mph < 1);
    // the dial's arrow points the way the wind blows (drawn pointing down at the golfer:
    // wind from the target, i.e. into), turned by where it comes from relative to the line
    $('cw-arrow').style.transform = `rotate(${(c.windFromDeg || 0) - this.aimDeg}deg)`;
    $('cw-wind').textContent = mph < 1 ? 'Calm' : `${Math.round(mph)} mph${c.gustMph >= 1 ? ` G${Math.round(mph + c.gustMph)}` : ''}`;
    const bits = [];
    if (mph >= 1) bits.push(ww.short);
    bits.push(`${Math.round(c.tempF ?? 70)}°F`);
    if ((c.altitudeFt ?? 0) >= 500) bits.push(`${(c.altitudeFt / 1000).toFixed(1)}k ft`);
    bits.push(firmnessLabel(c.firmness ?? 0.5));
    $('cw-sub').textContent = bits.join(' · ');
  }

  // ---- presets ----
  _renderPresets() {
    const box = $('cond-presets');
    box.innerHTML = '';
    for (const p of this.presets) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.id = p.id; b.textContent = p.label;
      b.onclick = () => this._post({ preset: p.id }, true);
      box.appendChild(b);
    }
  }

  // ---- sliders ----
  _bindSliders() {
    const map = [
      ['ce-wind', 'windMph', (v) => `${v} mph`],
      ['ce-gust', 'gustMph', (v) => `${v} mph`],
      ['ce-temp', 'tempF', (v) => `${v}°F`],
      ['ce-alt', 'altitudeFt', (v) => `${Number(v).toLocaleString()} ft`],
      ['ce-hum', 'humidity', (v) => `${v}%`],
      ['ce-firm', 'firmness', (v) => firmnessLabel(+v)],
      ['ce-stimp', 'greenStimp', (v) => `${(+v).toFixed(1)}`],
    ];
    this._sliders = map;
    for (const [id, key, fmt] of map) {
      $(id).oninput = (e) => {
        const v = +e.target.value;
        $(`${id}-v`).textContent = fmt(v);
        this._post({ [key]: v });
      };
    }
  }

  _renderSliders() {
    for (const [id, key, fmt] of this._sliders) {
      const v = this.c[key];
      if (document.activeElement !== $(id)) $(id).value = v;
      $(`${id}-v`).textContent = fmt(v);
    }
  }

  // ---- compass: drag the handle to where the wind comes FROM ----
  _buildCompass() {
    const g = $('cmp-ticks');
    for (let i = 0; i < 24; i++) {
      const a = i * 15 * DEG, major = i % 6 === 0;
      const r0 = major ? 58 : 63, r1 = 70;
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('x1', 80 + Math.sin(a) * r0); ln.setAttribute('y1', 80 - Math.cos(a) * r0);
      ln.setAttribute('x2', 80 + Math.sin(a) * r1); ln.setAttribute('y2', 80 - Math.cos(a) * r1);
      if (major) ln.setAttribute('class', 'major');
      g.appendChild(ln);
    }
    const svg = $('wind-compass');
    const angleAt = (e) => {
      const r = svg.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
      return Math.atan2(x, -y) / DEG;   // 0 = up (the target), clockwise
    };
    let dragging = false;
    const set = (e) => {
      const rel = Math.round(angleAt(e) / 5) * 5;
      const from = ((this.aimDeg + rel) % 360 + 360) % 360;
      this._post({ windFromDeg: from, ...(this.c.windMph < 1 ? { windMph: 8 } : {}) });
    };
    svg.addEventListener('pointerdown', (e) => { dragging = true; svg.setPointerCapture(e.pointerId); set(e); });
    svg.addEventListener('pointermove', (e) => { if (dragging) set(e); });
    svg.addEventListener('pointerup', () => { dragging = false; });
    svg.addEventListener('pointercancel', () => { dragging = false; });
  }

  _renderCompass() {
    if (!this.c) return;
    const rel = (this.c.windFromDeg || 0) - this.aimDeg;
    $('cmp-arrow').style.transform = `rotate(${rel}deg)`;
    $('cmp-arrow').style.opacity = this.c.windMph >= 1 ? 1 : 0.3;
    const ww = windWords(this.c.windMph, this.c.windFromDeg, this.aimDeg);
    $('ce-wind-read').textContent = this.c.windMph >= 1 ? `${Math.round(this.c.windMph)} mph` : 'Calm';
    $('ce-wind-rel').textContent = this.c.windMph >= 1 ? ww.long : 'Drag the dial to add wind';
  }

  // optimistic local update, then one POST per burst of changes
  _post(patch, now = false) {
    Object.assign(this._pending, patch);
    if (!patch.preset) this.setConditions({ ...this.c, ...patch, presetId: null });
    clearTimeout(this._postT);
    const send = async () => {
      const body = this._pending;
      this._pending = {};
      try {
        const r = await fetch('/api/conditions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => null);
        if (j && j.conditions) this.setConditions(j.conditions);
      } catch { /* the state stream will resync */ }
    };
    if (now) send(); else this._postT = setTimeout(send, 160);
  }
}
