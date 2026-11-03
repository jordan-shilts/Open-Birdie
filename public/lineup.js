// Lining up a shot: the club in hand, where it is predicted to go (lib/predict.js:
// the player's own numbers for that club, today's conditions, the real terrain), and
// every view of it: the club dock (each club's carry today + the one that fits), the
// shot card (to the pin, plays like, why), the planner (side view + overhead aim map +
// carry / total / where it ends), and the 3D view (predicted arc and landing zone).
const $ = (id) => document.getElementById(id);
const YD = 0.9144, FT = 0.3048;

export const CLUBS = [
  { label: 'DR', key: 'DR', name: 'Driver' },
  { label: '3W', key: 'W3', name: '3 wood' },
  { label: '3H', key: 'H3', name: '3 hybrid' },
  { label: '4i', key: 'I4', name: '4 iron' },
  { label: '5i', key: 'I5', name: '5 iron' },
  { label: '6i', key: 'I6', name: '6 iron' },
  { label: '7i', key: 'I7', name: '7 iron' },
  { label: '8i', key: 'I8', name: '8 iron' },
  { label: '9i', key: 'I9', name: '9 iron' },
  { label: 'PW', key: 'PW', name: 'Pitching wedge' },
  { label: 'SW', key: 'SW', name: 'Sand wedge' },
  { label: 'LW', key: 'LW', name: 'Lob wedge' },
  { label: 'PT', key: 'PT', name: 'Putter' },
];
const byKey = Object.fromEntries(CLUBS.map((c) => [c.key, c]));
export const clubByLabel = (label) => CLUBS.find((c) => c.label.toUpperCase() === String(label).toUpperCase()) || null;

const SURFACE_WORDS = { fairway: 'Fairway', green: 'Green', rough: 'Rough', bunker: 'Bunker', water: 'Water', ob: 'Out of bounds', tee: 'Tee', range: 'Range' };
const HAZARD = new Set(['water', 'ob', 'bunker']);
const num = (v, unit) => (Number.isFinite(v) ? `${Math.round(v)}<small>${unit}</small>` : '–');

// How wide the landing band is drawn: the prediction's areas are ~2 sigma (about 19 in
// 20 swings, "generous"); "tight" halves them (about 2 in 3).
const SPREAD_KEY = 'open-birdie.spread';
// Pick the club that fits at every new lie (like a sim's auto club); off: the club
// stays what the player or the launch monitor last chose.
const AUTO_CLUB_KEY = 'open-birdie.autoClub';
export const readAutoClub = () => { try { return localStorage.getItem(AUTO_CLUB_KEY) !== '0'; } catch { return true; } };
export const writeAutoClub = (on) => { try { localStorage.setItem(AUTO_CLUB_KEY, on ? '1' : '0'); } catch { /* private mode */ } };
const SPREAD = { tight: 0.5, generous: 1 };
const readSpread = () => { try { return SPREAD[localStorage.getItem(SPREAD_KEY)] ? localStorage.getItem(SPREAD_KEY) : 'generous'; } catch { return 'generous'; } };

// The prediction as drawn: dispersion areas scaled to the chosen spread, and the band
// of carry distances (and bearings, relative to north) its landing area covers.
export function withSpread(pred, spread, ball) {
  if (!pred || pred.isPutt || !pred.dispersion) return pred;
  const k = SPREAD[spread] ?? 1;
  const scale = (pts, c) => (pts && c ? pts.map((q) => ({ x: c.x + (q.x - c.x) * k, y: c.y + (q.y - c.y) * k })) : pts);
  const land = scale(pred.dispersion.land, pred.land);
  const rest = scale(pred.dispersion.rest, pred.rest);
  let band = null;
  if (land && land.length && ball) {
    let lo = Infinity, hi = -Infinity, a0 = Infinity, a1 = -Infinity;
    const ref = Math.atan2(pred.land.x - ball.x, pred.land.y - ball.y);
    for (const q of land) {
      const d = Math.hypot(q.x - ball.x, q.y - ball.y) / YD;
      let a = Math.atan2(q.x - ball.x, q.y - ball.y) - ref;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      lo = Math.min(lo, d); hi = Math.max(hi, d); a0 = Math.min(a0, a); a1 = Math.max(a1, a);
    }
    band = { minYd: lo, maxYd: hi, carryYd: pred.carryYd, fromRad: ref + a0, toRad: ref + a1 };
  }
  return { ...pred, dispersion: { ...pred.dispersion, land, rest }, band, spread };
}
const yds = (v) => num(v, 'yd');

export class Lineup {
  constructor({ scene, flightView, aimMap, conditions, onClubChange = null }) {
    this.scene = scene;
    this.flightView = flightView;
    this.aimMap = aimMap;
    this.conditions = conditions;
    this.onClubChange = onClubChange;
    this.state = null;
    this.club = 'DR';
    this.manualClub = false;   // the player picked this club at this lie
    this.lieKey = '';
    this.condKey = '';
    this.aim = 0;              // aim offset in effect (degrees, + right)
    this.pred = null;
    this.carries = null;
    this.flying = false;
    this._predAbort = null;
    this._predT = null;
    this.spread = readSpread();
    this.autoClub = readAutoClub();
    this._pickPending = false;   // a new lie still waiting for its auto club pick
    this._buildDock();
    this._bindSpread();
  }

  _bindSpread() {
    const box = $('seg-spread');
    const mark = () => box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.value === this.spread ? 'true' : 'false'));
    box.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        this.spread = b.dataset.value;
        try { localStorage.setItem(SPREAD_KEY, this.spread); } catch { /* private mode */ }
        mark();
        if (this.pred) this.render(this.pred);
      };
    });
    mark();
  }

  get clubInfo() { return byKey[this.club] || CLUBS[0]; }

  // ---- club dock ----
  _buildDock() {
    const dock = $('clubs');
    dock.innerHTML = '';
    for (const c of CLUBS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'club'; b.dataset.key = c.key;
      b.setAttribute('role', 'radio');
      b.title = c.name;
      b.innerHTML = `<b>${c.label}</b><span></span>`;
      b.onclick = () => this.selectClub(c.key, { manual: true });
      dock.appendChild(b);
    }
    this._renderDock();
  }

  _renderDock() {
    const rec = this.carries?.recommended;
    for (const b of document.querySelectorAll('#clubs .club')) {
      const k = b.dataset.key;
      const on = k === this.club;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('rec', k === rec && !this.state?.holed);
      const c = this.carries?.clubs?.find((x) => x.club === k);
      b.querySelector('span').textContent = k === 'PT' ? '' : c && Number.isFinite(c.carryYd) ? Math.round(c.carryYd) : '';
      b.title = c ? `${byKey[k].name}: carry ${Math.round(c.carryYd)}, total ${Math.round(c.totalYd)} yd today (${c.source === 'player' ? 'your numbers' : c.source === 'scaled' ? 'scaled from your other clubs' : 'typical numbers'})` : byKey[k].name;
    }
    $('lie-club').textContent = this.clubInfo.name;
  }

  selectClub(key, { manual = false, tell = true } = {}) {
    if (!byKey[key]) return;
    const changed = key !== this.club;
    this.club = key;
    if (manual) this.manualClub = true;
    this._renderDock();
    if (tell && changed) fetch('/api/club', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ club: key }) }).catch(() => {});
    if (changed) this.onClubChange?.(key);
    this.predict();
  }

  // a shot came in with the monitor's own club: show it in hand
  markClubLabel(label) {
    const c = clubByLabel(label);
    if (c && c.key !== this.club) { this.club = c.key; this._renderDock(); }
  }

  // ---- state ----
  setState(s) {
    this.state = s;
    if (!s || !s.loaded) return;
    $('planner').classList.remove('hidden');
    const base = s.aimDeg - (s.aimOffset || 0);
    this.conditions?.setAimDeg(base);
    const lie = `${s.courseName}|${s.hole}|${s.practice ? s.practice.mode + s.pin.join(',') : ''}|${s.ball.x.toFixed(2)},${s.ball.y.toFixed(2)}`;
    // conditions and terrain readiness both change every club's numbers
    const cond = JSON.stringify(s.conditions || null) + (s.runtimeReady ? '|ready' : '|wait');
    const newLie = lie !== this.lieKey;
    const newCond = cond !== this.condKey;
    this.lieKey = lie;
    this.condKey = cond;
    if (!this._dragging) this.aim = s.aimOffset || 0;
    this.aimMap.setHole({
      ball: s.ball, pin: s.pin, baseAimDeg: base, aimOffset: this.aim,
      line: s.practice ? null : (this.scene.geo?.holes?.[s.hole - 1]?.line || null),
    });
    const wind = s.conditions ? { mph: s.conditions.windMph, fromDeg: s.conditions.windFromDeg, gustMph: s.conditions.gustMph } : null;
    this.aimMap.setWind(wind);
    this.scene.setWind?.(wind || {});
    this.conditions?.setConditions(s.conditions || null);
    this._renderShotCard();
    if (newLie) {
      this.manualClub = false;
      this._pickPending = true;
      if (s.selectedClub && byKey[s.selectedClub]) { this.club = s.selectedClub; this._renderDock(); }
    }
    if (newLie || newCond) this.refreshCarries();
    else this.predict();
  }

  async refreshCarries() {
    try {
      const r = await fetch('/api/carries');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.carries = await r.json();
    } catch {
      this.carries = null;   // not ready yet (409 until the terrain is), or an older server
    }
    const s = this.state;
    // the auto pick waits for real carries; a club the player chose here stands
    if (this._pickPending && this.carries?.recommended && s) {
      this._pickPending = false;
      const pick = s.lie === 'green' ? 'PT' : this.carries.recommended;
      if (this.autoClub && !this.manualClub && pick !== this.club) { this.selectClub(pick); return; }
    }
    this._renderDock();
    this.predict();
  }

  // ---- aim ----
  // a live aim (slider drag, map drag, keys): preview at once, commit after a pause
  setAim(offset, { commit = true } = {}) {
    const s = this.state;
    if (!s) return;
    this.aim = Math.max(-30, Math.min(30, Math.round(offset * 2) / 2));
    this._dragging = true;
    $('aim-slider').value = this.aim;
    $('aim-val').textContent = `${this.aim > 0 ? 'R' : this.aim < 0 ? 'L' : ''}${Math.abs(this.aim).toFixed(1)}°`;
    this.aimMap.setAim(this.aim);
    this.scene.setAim(s.aimDeg - (s.aimOffset || 0) + this.aim);
    this.predict({ debounce: 40 });
    clearTimeout(this._aimT);
    if (commit) {
      this._aimT = setTimeout(() => {
        fetch('/api/aim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: this.aim }) })
          .finally(() => { this._dragging = false; });
      }, 220);
    }
  }

  autoAim() {
    const a = this.pred?.aimAssist;
    if (!a || !Number.isFinite(a.offsetDeg)) return false;
    this.setAim(a.offsetDeg);
    return true;
  }

  // ---- prediction ----
  predict({ debounce = 0 } = {}) {
    clearTimeout(this._predT);
    this._predT = setTimeout(() => this._predict(), debounce);
  }

  async _predict() {
    const s = this.state;
    if (!s || !s.loaded || s.holed || this.flying) return;
    this._predAbort?.abort();
    const ctrl = new AbortController();
    this._predAbort = ctrl;
    const q = new URLSearchParams({ club: this.club, aim: String(this.aim) });
    let pred = null;
    try {
      const r = await fetch(`/api/predict?${q}`, { signal: ctrl.signal });
      if (r.ok) pred = await r.json();
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    if (ctrl !== this._predAbort) return;
    if (pred && !pred.error) pred.clubName = this.clubInfo.name;
    this.render(pred && !pred.error ? pred : null);
  }

  render(pred) {
    this.pred = pred;
    const c = this.clubInfo;
    const isPutt = !!pred?.isPutt;
    $('planner').classList.remove('hidden');
    $('pl-eyebrow').textContent = pred ? `PREDICTED · ${c.name.toUpperCase()}` : `${c.name.toUpperCase()}`;
    const src = pred?.source;
    $('pl-source').textContent = !pred ? 'Prediction unavailable'
      : isPutt ? this._puttRead(pred)
      : src === 'player' ? `Your ${c.name.toLowerCase()}: last ${pred.n} shot${pred.n === 1 ? '' : 's'}`
      : src === 'scaled' ? `Typical ${c.name.toLowerCase()}, scaled to your speed`
      : `Typical ${c.name.toLowerCase()}: hit a few to learn yours`;
    $('pl-carry').innerHTML = pred && !isPutt ? yds(pred.carryYd) : '–';
    $('pl-total').innerHTML = pred ? (isPutt ? num(pred.totalYd * 3, 'ft') : yds(pred.totalYd)) : '–';
    const ends = pred?.restSurface || pred?.landSurface;
    const water = pred?.events?.some((e) => e.type === 'water');
    const tree = pred?.events?.find((e) => e.type === 'tree');
    const lands = $('pl-lands');
    lands.textContent = !pred ? '–' : water ? 'Water' : tree && ends !== 'fairway' && ends !== 'green' ? `Trees · ${SURFACE_WORDS[ends] || ends}` : (SURFACE_WORDS[ends] || ends || '–');
    lands.classList.toggle('hazard', !!pred && (water || HAZARD.has(ends)));
    this._renderShotCard();
    const drawn = withSpread(pred, this.spread, this.state?.ball);
    const b = drawn?.band;
    $('pl-band').textContent = b ? `${Math.round(b.minYd)}–${Math.round(b.maxYd)} yd` : '–';
    this.aimMap.setPrediction(drawn);
    this.flightView.showPrediction(pred);
    this.scene.setLineup?.(this.flying ? null : drawn);
    this.conditions?.setEffects(pred);
  }

  // the putt's read: where to start it, at today's green speed
  _puttRead(pred) {
    const a = pred.aimAssist?.offsetDeg;
    const stimp = this.state?.conditions?.greenStimp ?? 10.5;
    const read = Number.isFinite(a) && Math.abs(a) >= 0.25 ? `start it ${Math.abs(a).toFixed(1)}° ${a > 0 ? 'right' : 'left'} (AUTO aims it)` : 'straight';
    return `Read: ${read} · stimp ${stimp}`;
  }

  _renderShotCard() {
    const s = this.state;
    if (!s) return;
    const p = this.pred;
    const d = s.distToPinYd;
    $('lie-pin').innerHTML = d > 45 ? num(d, 'yd') : num(d * 3, 'ft');
    $('mm-topin').textContent = d > 45 ? `${Math.round(d)} yd` : `${Math.round(d * 3)} ft`;
    const show = p && !p.isPutt && Number.isFinite(p.playsLikeYd) && d > 45;
    $('sc-plays-box').classList.toggle('hidden', !show);
    if (show) $('sc-plays').innerHTML = num(p.playsLikeYd, 'yd');
    // why it plays that way: each condition's share of the difference, in yards
    let why = '';
    if (show) {
      const e = p.effects || {};
      const k = p.carryYd > 0 ? d / p.carryYd : 1;
      const parts = [];
      const add = (label, v) => { const r = Math.round(v); if (Math.abs(r) >= 1) parts.push(`${label} ${r > 0 ? '+' : '−'}${Math.abs(r)}`); };
      add('Wind', -(e.windCarryYd || 0) * k);
      add('Air', -(e.airCarryYd || 0) * k);
      const pinUp = this._pinRiseFt();
      if (Number.isFinite(pinUp) && Math.abs(pinUp) >= 3) add(pinUp > 0 ? 'Uphill' : 'Downhill', pinUp * FT / YD);
      why = parts.join(' · ');
    }
    $('sc-why').textContent = why;
    $('hud-lie').textContent = s.holed ? 'Holed' : (SURFACE_WORDS[s.lie] || s.lie || '–');
    const rise = this._pinRiseFt();
    $('sc-elev').textContent = Number.isFinite(rise) ? `${rise >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(rise))} ft` : '–';
  }

  // the pin's height above the ball, in feet
  _pinRiseFt() {
    const s = this.state;
    if (!s || !this.scene.geo) return NaN;
    return (this.scene.hAt(s.pin[0], s.pin[1]) - this.scene.hAt(s.ball.x, s.ball.y)) / FT;
  }

  // ---- shot in the air ----
  setFlying(on) {
    this.flying = on;
    document.body.classList.toggle('flying', on);
    if (on) { this.scene.setLineup?.(null); this._predAbort?.abort(); }
  }
}
