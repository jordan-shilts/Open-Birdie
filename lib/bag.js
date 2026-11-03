'use strict';
// The player's bag: the player's own launches per club, and from them a launch model
// per club that the lineup predicts with (lib/predict.js).
//
// Every full shot from the launch monitor is recorded (not putts, not mishits, not
// practice-panel test shots). Storage sits behind a tiny async interface, so another
// backend (a hosted database) can replace the JSON file without touching predict.js
// or server.js:
//
//   store.load()                      -> Promise<shot[]>   the stored shots, oldest first
//   store.append(club, launch, meta)  -> Promise           one more shot
//   store.reset()                     -> Promise           forget every shot
//
// A stored shot carries enough to rebuild the history anywhere:
//   { club, speedMph, vla, hla, totalSpin, spinAxis, at (epoch ms),
//     course, hole, lie, practice, clubName }   (the last five only when known)
// createStore() picks the backend; today that is always the file store at
// DATA_DIR/bag.json, which keeps the last 30 shots of each club. The Bag keeps the
// same in memory, so models are synchronous whatever the store.

const fs = require('fs');
const path = require('path');
const { CLUB_FULL, clubKey, shotClubKey, launchFromBall } = require('./game');

const MAX_PER_CLUB = 30;
const MISHIT_RATIO = 0.55;     // slower than 55 % of the club's typical ball speed: a mishit
const PLAYER_MIN_N = 3;        // shots of a club before its model is the player's own
const SD_MIN_N = 5;            // shots of a club before its spread comes from the data
const FULL_CLUBS = Object.freeze(Object.keys(CLUB_FULL).filter((k) => k !== 'PT'));

// Typical one-sigma spread of a launch by club, for a club with too few shots:
// ball speed in % of the model's speed, launch angles and spin axis in degrees.
const DEFAULT_SD = Object.freeze({
  DR: { speedPct: 3.0, vla: 1.5, hla: 2.5, spinAxis: 6 },
  W3: { speedPct: 2.8, vla: 1.5, hla: 2.3, spinAxis: 5.5 },
  H3: { speedPct: 2.8, vla: 1.5, hla: 2.2, spinAxis: 5 },
  I4: { speedPct: 2.8, vla: 1.5, hla: 2.2, spinAxis: 5 },
  I5: { speedPct: 2.7, vla: 1.5, hla: 2.0, spinAxis: 4.5 },
  I6: { speedPct: 2.7, vla: 1.5, hla: 2.0, spinAxis: 4.5 },
  I7: { speedPct: 2.6, vla: 1.5, hla: 1.8, spinAxis: 4 },
  I8: { speedPct: 2.6, vla: 1.5, hla: 1.8, spinAxis: 4 },
  I9: { speedPct: 2.6, vla: 1.5, hla: 1.7, spinAxis: 3.5 },
  PW: { speedPct: 2.5, vla: 1.5, hla: 1.5, spinAxis: 3 },
  SW: { speedPct: 2.5, vla: 1.5, hla: 1.5, spinAxis: 3 },
  LW: { speedPct: 2.5, vla: 1.5, hla: 1.5, spinAxis: 3 },
  PT: { speedPct: 4.0, vla: 0, hla: 1.0, spinAxis: 0 },
});
// Spreads measured from the data never go below these (a launch monitor emulator can
// send the same ball five times).
const SD_FLOOR = Object.freeze({ speedPct: 0.5, vla: 0.3, hla: 0.3, spinAxis: 0.5 });

const round = (v, d) => { const f = 10 ** d; const r = Math.round(v * f) / f; return r === 0 ? 0 : r; };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function sampleSd(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) * (v - m), 0) / (values.length - 1));
}

const META_STRINGS = ['course', 'lie', 'practice', 'clubName'];

// A stored shot, validated: null when it is not a full shot of a known club.
function cleanShot(s, now = Date.now) {
  if (!s || typeof s !== 'object') return null;
  const club = typeof s.club === 'string' && FULL_CLUBS.includes(s.club) ? s.club : null;
  if (!club) return null;
  if (![s.speedMph, s.vla, s.hla, s.totalSpin, s.spinAxis].every(finite) || s.speedMph <= 0) return null;
  const shot = {
    club,
    speedMph: round(s.speedMph, 2),
    vla: round(s.vla, 2),
    hla: round(s.hla, 2),
    totalSpin: Math.round(s.totalSpin),
    spinAxis: round(s.spinAxis, 2),
    at: finite(s.at) ? Math.round(s.at) : now(),
  };
  for (const key of META_STRINGS) {
    if (typeof s[key] === 'string' && s[key].trim()) shot[key] = s[key].trim().slice(0, 120);
  }
  if (Number.isInteger(s.hole) && s.hole > 0 && s.hole < 1000) shot.hole = s.hole;
  return shot;
}

// Keep the last `max` shots of every club (the list is oldest first).
function capPerClub(shots, max) {
  const seen = new Map();
  const keep = new Array(shots.length).fill(false);
  for (let i = shots.length - 1; i >= 0; i--) {
    const n = seen.get(shots[i].club) || 0;
    if (n < max) { keep[i] = true; seen.set(shots[i].club, n + 1); }
  }
  return shots.filter((_, i) => keep[i]);
}

// ---------- the default store: a JSON file ----------
// { version: 1, shots: [shot, ...] }, written whole (temp file + rename) on every
// change. A file that cannot be parsed is moved aside (bag.json.corrupt) and the bag
// starts empty, so a later shot never overwrites a history someone could still rescue.
function createFileStore(file, { maxPerClub = MAX_PER_CLUB, log = console } = {}) {
  let shots = null;
  const read = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`[bag] cannot read ${path.basename(file)}: ${err.message}`);
      return [];
    }
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data && Array.isArray(data.shots) ? data.shots : null;
      if (!list) throw new Error('no shots list');
      return capPerClub(list.map((s) => cleanShot(s)).filter(Boolean), maxPerClub);
    } catch (err) {
      log.warn(`[bag] ignoring ${path.basename(file)}: ${err.message}`);
      try { fs.renameSync(file, `${file}.corrupt`); } catch (_) { /* leave it */ }
      return [];
    }
  };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, shots }));
    fs.renameSync(tmp, file);
  };
  return {
    kind: 'file',
    file,
    async load() {
      shots = read();
      return shots.map((s) => ({ ...s }));
    },
    async append(club, launch, meta = {}) {
      if (!shots) shots = read();
      const shot = cleanShot({ ...meta, ...launch, club });
      if (!shot) return;
      shots.push(shot);
      shots = capPerClub(shots, maxPerClub);
      write();
    },
    async reset() {
      shots = [];
      write();
    },
  };
}

// The store for this install. One backend today (the file); a hosted store would be
// chosen here (e.g. from an environment variable) and nothing else would change.
function createStore({ dataDir, log = console } = {}) {
  if (!dataDir) throw new Error('createStore needs a dataDir');
  return createFileStore(path.join(dataDir, 'bag.json'), { log });
}

// ---------- the bag ----------
class Bag {
  constructor({ store = null, maxPerClub = MAX_PER_CLUB, now = Date.now, log = console } = {}) {
    this.store = store;
    this.maxPerClub = maxPerClub;
    this.now = now;
    this.log = log;
    this.byClub = new Map();      // club key -> shots, oldest first, at most maxPerClub
    this.version = 0;             // bumped on every change
    this._chain = Promise.resolve();   // store calls, one at a time, in order
    this._since = null;           // shots recorded while a load is in flight
    this.ready = Promise.resolve(this);
  }

  _queue(fn) {
    const p = this._chain.then(fn);
    this._chain = p.catch(() => {});
    return p;
  }

  // Every store call made so far has finished (or failed).
  flush() { return this._chain.then(() => this); }

  _push(shot) {
    const list = this.byClub.get(shot.club) || [];
    list.push(shot);
    while (list.length > this.maxPerClub) list.shift();
    this.byClub.set(shot.club, list);
  }

  // Read the history from the store. Shots recorded meanwhile are kept (after it).
  load() {
    if (!this.store || typeof this.store.load !== 'function') return this.ready;
    const since = [];
    this._since = since;
    this.ready = this._queue(() => this.store.load()).then((stored) => {
      this.byClub.clear();
      const shots = (Array.isArray(stored) ? stored : []).map((s) => cleanShot(s, this.now)).filter(Boolean);
      for (const s of [...shots.sort((a, b) => a.at - b.at), ...since]) this._push(s);
      return this;
    }, (err) => {
      this.log.warn(`[bag] could not load the shot history: ${err.message}`);
      return this;
    }).finally(() => { if (this._since === since) this._since = null; this.version++; });
    return this.ready;
  }

  /**
   * Record one launch for a club. meta: { at, course, hole, lie, practice, clubName }.
   * Returns { recorded, club, n } or { recorded: false, club, reason } — reason:
   * 'putt' | 'unknown-club' | 'invalid' | 'mishit'.
   */
  record(club, launch, meta = {}) {
    const key = clubKey(club);
    if (key === 'PT') return { recorded: false, club: key, reason: 'putt' };
    if (!key || !FULL_CLUBS.includes(key)) return { recorded: false, club: null, reason: 'unknown-club' };
    const shot = cleanShot({ ...meta, ...launch, club: key, at: finite(meta.at) ? meta.at : this.now() }, this.now);
    if (!shot) return { recorded: false, club: key, reason: 'invalid' };
    if (shot.speedMph < MISHIT_RATIO * CLUB_FULL[key].speedMph) return { recorded: false, club: key, reason: 'mishit' };
    this._push(shot);
    if (this._since) this._since.push(shot);
    this.version++;
    if (this.store && typeof this.store.append === 'function') {
      const launchPart = { speedMph: shot.speedMph, vla: shot.vla, hla: shot.hla, totalSpin: shot.totalSpin, spinAxis: shot.spinAxis };
      const metaPart = {};
      for (const k of ['at', 'course', 'hole', 'lie', 'practice', 'clubName']) if (shot[k] !== undefined) metaPart[k] = shot[k];
      this._queue(() => this.store.append(key, launchPart, metaPart))
        .catch((err) => this.log.warn(`[bag] could not store a ${key} shot: ${err.message}`));
    }
    return { recorded: true, club: key, n: this.byClub.get(key).length };
  }

  /**
   * Record a launch-monitor shot: raw Open Connect ball data, the monitor's club name
   * (or none: then the club the player picked), whether the game played it as a putt,
   * and where it was hit from (meta: course, hole, lie, practice).
   */
  recordShot({ ball, clubName = null, selectedClub = null, isPutt = false, meta = {} } = {}) {
    const key = shotClubKey(clubName, selectedClub);
    if (isPutt || key === 'PT') return { recorded: false, club: key, reason: 'putt' };
    if (!key) return { recorded: false, club: null, reason: 'unknown-club' };
    const launch = launchFromBall(ball);
    if (!launch) return { recorded: false, club: key, reason: 'invalid' };
    return this.record(key, launch, { ...meta, ...(clubName ? { clubName: String(clubName) } : {}) });
  }

  // Forget every shot (here at once, in the store in order).
  reset() {
    this.byClub.clear();
    if (this._since) this._since.length = 0;
    this.version++;
    if (!this.store || typeof this.store.reset !== 'function') return Promise.resolve();
    return this._queue(() => this.store.reset());
  }

  shots(club) {
    const key = clubKey(club);
    return (key && this.byClub.get(key) || []).map((s) => ({ ...s }));
  }

  get total() {
    let n = 0;
    for (const list of this.byClub.values()) n += list.length;
    return n;
  }

  // The player's ball speed against the typical speed: the median over the clubs
  // with shots of (club's median speed / CLUB_FULL speed). Null with no shots.
  speedRatio() {
    const ratios = [];
    for (const [club, list] of this.byClub) {
      if (list.length && CLUB_FULL[club]) ratios.push(median(list.map((s) => s.speedMph)) / CLUB_FULL[club].speedMph);
    }
    return ratios.length ? median(ratios) : null;
  }

  /**
   * The launch the lineup predicts a club with:
   *   source 'player'  (>= 3 shots): median speed, VLA and spin; mean HLA and spin
   *                     axis, so the player's start line and curve carry over;
   *   source 'scaled'  (fewer, but other clubs have shots): the CLUB_FULL preset with
   *                     its ball speed scaled by the player's speed ratio (speedRatio);
   *   source 'typical' (no shots at all): the CLUB_FULL preset, hla 0, axis 0.
   * sd: one-sigma spread (speed mph, angles deg) from the shots when there are >= 5,
   * else typical for the club.
   */
  model(club) {
    return modelFor(this, club);
  }

  // GET /api/bag: every full club, in bag order.
  summary() {
    return {
      clubs: FULL_CLUBS.map((club) => {
        const m = this.model(club);
        const list = this.byClub.get(club) || [];
        return { club, n: m.n, source: m.source, launch: m.launch, sd: m.sd, lastAt: list.length ? list[list.length - 1].at : null };
      }),
      total: this.total,
      maxPerClub: this.maxPerClub,
      store: this.store && this.store.kind || null,
    };
  }
}

function defaultSd(club, speedMph) {
  const d = DEFAULT_SD[club] || DEFAULT_SD.I7;
  return { speedMph: speedMph * d.speedPct / 100, vla: d.vla, hla: d.hla, spinAxis: d.spinAxis };
}

function roundLaunch(l) {
  return { speedMph: round(l.speedMph, 1), vla: round(l.vla, 1), hla: round(l.hla, 2), totalSpin: Math.round(l.totalSpin), spinAxis: round(l.spinAxis, 2) };
}
function roundSd(s) {
  return { speedMph: round(s.speedMph, 2), vla: round(s.vla, 2), hla: round(s.hla, 2), spinAxis: round(s.spinAxis, 2) };
}

// The model for a club from a bag (or from no bag at all: the typical preset).
function modelFor(bag, club) {
  const key = clubKey(club);
  const preset = key && CLUB_FULL[key];
  if (!preset) return null;
  const list = bag && key !== 'PT' ? (bag.byClub.get(key) || []) : [];
  const n = list.length;
  let source, launch, sd;
  if (n >= PLAYER_MIN_N) {
    source = 'player';
    launch = {
      speedMph: median(list.map((s) => s.speedMph)),
      vla: median(list.map((s) => s.vla)),
      hla: mean(list.map((s) => s.hla)),
      totalSpin: median(list.map((s) => s.totalSpin)),
      spinAxis: mean(list.map((s) => s.spinAxis)),
    };
  } else {
    const ratio = bag && key !== 'PT' ? bag.speedRatio() : null;
    source = ratio !== null ? 'scaled' : 'typical';
    launch = { speedMph: preset.speedMph * (ratio ?? 1), vla: preset.vla, hla: 0, totalSpin: preset.spin, spinAxis: 0 };
  }
  launch = roundLaunch(launch);
  if (source === 'player' && n >= SD_MIN_N) {
    sd = {
      speedMph: Math.max(sampleSd(list.map((s) => s.speedMph)), launch.speedMph * SD_FLOOR.speedPct / 100),
      vla: Math.max(sampleSd(list.map((s) => s.vla)), SD_FLOOR.vla),
      hla: Math.max(sampleSd(list.map((s) => s.hla)), SD_FLOOR.hla),
      spinAxis: Math.max(sampleSd(list.map((s) => s.spinAxis)), SD_FLOOR.spinAxis),
    };
  } else {
    sd = defaultSd(key, launch.speedMph);
  }
  return { club: key, source, n, launch, sd: roundSd(sd) };
}

// The bag for this install: its store (the file under dataDir unless one is given),
// with the history loading in the background (await bag.ready for it).
function createBag({ dataDir, store = null, log = console, ...options } = {}) {
  const bag = new Bag({ store: store || createStore({ dataDir, log }), log, ...options });
  bag.load();
  return bag;
}

module.exports = {
  Bag,
  DEFAULT_SD,
  FULL_CLUBS,
  MAX_PER_CLUB,
  MISHIT_RATIO,
  cleanShot,
  createBag,
  createFileStore,
  createStore,
  modelFor,
};
