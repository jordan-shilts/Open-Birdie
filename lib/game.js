'use strict';
// Round state: current hole, ball position, strokes, scoring, penalties.

const { simulateShot, YD } = require('./physics');
const { makeSurfaceLookup } = require('./course');
const { makeTerrain, flatTerrain } = require('./elevation');
const { buildTreeObstacles } = require('./tree-obstacles');
const { PracticeSession } = require('./practice');
const { conditionsState, normalizeConditions, physicsOptions, resolveConditions, shotWind } = require('./conditions');

const PREPARED_COURSE_FIELDS = Object.freeze([
  'course',
  'surfaceAt',
  'terrain',
  'treeObstacles',
  'runtimeReady',
  'practice',
  'holeIndex',
  'over',
  'scores',
  'pickedUp',
  'shotLog',
  'ball',
  'strokes',
  'lie',
  'holed',
  'aimOffset',
]);

const CLUB_FULL = { // typical full-shot launch presets, used by the practice panel
  DR: { speedMph: 152, vla: 13.0, spin: 2600 },
  W3: { speedMph: 142, vla: 13.5, spin: 3400 },
  H3: { speedMph: 133, vla: 14.5, spin: 4200 },
  I4: { speedMph: 127, vla: 15.0, spin: 4800 },
  I5: { speedMph: 122, vla: 16.5, spin: 5300 },
  I6: { speedMph: 117, vla: 17.5, spin: 6000 },
  I7: { speedMph: 111, vla: 19.0, spin: 7000 },
  I8: { speedMph: 105, vla: 21.0, spin: 7900 },
  I9: { speedMph: 99, vla: 23.0, spin: 8600 },
  PW: { speedMph: 91, vla: 25.5, spin: 9300 },
  SW: { speedMph: 78, vla: 29.0, spin: 10000 },
  LW: { speedMph: 68, vla: 32.0, spin: 10500 },
  PT: { speedMph: 8, vla: 0.5, spin: 100 },
};

// The CLUB_FULL key for whatever a launch monitor, its bridge or the UI calls a club:
// 'DRIVER', '1W', 'WOOD3', '3W', 'HYBRID3', '3H', 'U3', 'IRON7', '7I', 'I7', '7 Iron',
// 'PW', 'Sand Wedge', 'PUTTER', a wedge loft ('52', '56°')... Clubs without a key of
// their own go to the nearest one: 2- and 4-woods to the 3-wood, 5- to 11-woods and
// 1- to 3-irons to the 3-hybrid, 4+ hybrids to their iron, gap / approach wedges
// (~50°) to the pitching wedge. Null when the name is no club we know.
const CLUB_ALIASES = Object.freeze({
  DR: 'DR', D: 'DR', DRV: 'DR', DRIVER: 'DR', MINIDRIVER: 'W3',
  PW: 'PW', PITCHING: 'PW', PITCHINGWEDGE: 'PW', WEDGEPITCHING: 'PW',
  GW: 'PW', AW: 'PW', UW: 'PW', GAP: 'PW', GAPWEDGE: 'PW', APPROACH: 'PW', APPROACHWEDGE: 'PW',
  SW: 'SW', SAND: 'SW', SANDWEDGE: 'SW', WEDGESAND: 'SW',
  LW: 'LW', LOB: 'LW', LOBWEDGE: 'LW', WEDGELOB: 'LW',
  PT: 'PT', PUTT: 'PT', PUTTER: 'PT',
});
const WOOD = 'W|WOOD|FW|FAIRWAY|FAIRWAYWOOD';
const HYBRID = 'H|HY|HYB|HYBRID|U|UT|UTILITY|RESCUE';
const IRON = 'I|IR|IRON';
const numbered = (kinds) => [new RegExp(`^(?:${kinds})(\\d{1,2})$`), new RegExp(`^(\\d{1,2})(?:${kinds})$`)];
const WOOD_RE = numbered(WOOD), HYBRID_RE = numbered(HYBRID), IRON_RE = numbered(IRON);
const LOFT_RE = [/^(?:WEDGE|W)?(\d{2})(?:DEG|D)?$/, /^(\d{2})(?:DEG|D)?(?:WEDGE|W)$/];
const matchNumber = (res, s) => {
  for (const re of res) { const m = re.exec(s); if (m) return +m[1]; }
  return null;
};
const wedgeByLoft = (loft) => (loft >= 40 && loft <= 64 ? (loft <= 50 ? 'PW' : loft <= 57 ? 'SW' : 'LW') : null);

function clubKey(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (CLUB_ALIASES[s]) return CLUB_ALIASES[s];
  let n = matchNumber(WOOD_RE, s);
  if (n !== null) return n === 1 ? 'DR' : n >= 2 && n <= 4 ? 'W3' : n >= 5 && n <= 11 ? 'H3' : wedgeByLoft(n);
  n = matchNumber(HYBRID_RE, s);
  if (n !== null) return n >= 1 && n <= 3 ? 'H3' : n >= 4 && n <= 9 ? `I${n}` : null;
  n = matchNumber(IRON_RE, s);
  if (n !== null) return n >= 1 && n <= 3 ? 'H3' : n >= 4 && n <= 9 ? `I${n}` : null;
  n = matchNumber(LOFT_RE, s);
  return n !== null ? wedgeByLoft(n) : null;
}

// The club a shot was hit with: the monitor's club when it names one (null when that
// name is no club we know: never guess), else the club the player picked.
function shotClubKey(clubName, selectedClub = null) {
  if (clubName !== null && clubName !== undefined && String(clubName).trim() !== '') return clubKey(clubName);
  return clubKey(selectedClub);
}

// Launch-monitor ball data -> a sanitized launch, or null when the ball speed is
// missing or implausible. Launch monitors stream partial/garbage frames (mid-write
// reads, sensor glitches); one bad packet must not push NaN into the physics.
function launchFromBall(ball) {
  ball = ball || {};
  const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const speedMph = fin(ball.Speed);
  if (speedMph === null || speedMph <= 0 || speedMph > 250) return null;
  const clampN = (v, lo, hi, dflt) => { const n = fin(v); return n === null ? dflt : Math.max(lo, Math.min(hi, n)); };
  const back = fin(ball.BackSpin) ?? 0, side = fin(ball.SideSpin) ?? 0;
  const spinAxis = fin(ball.SpinAxis);
  return {
    speedMph,
    vla: clampN(ball.VLA, 0, 60, 0),
    hla: clampN(ball.HLA, -45, 45, 0),
    totalSpin: clampN(ball.TotalSpin, 0, 15000, Math.min(15000, Math.hypot(back, side))),
    spinAxis: spinAxis !== null ? spinAxis : (back ? Math.atan2(-side, back) * 180 / Math.PI : 0),
  };
}

class Game {
  constructor({
    surfaceLookupFactory = makeSurfaceLookup,
    terrainFactory = makeTerrain,
    flatTerrainFactory = flatTerrain,
  } = {}) {
    this._courseFactories = Object.freeze({
      surfaceLookupFactory,
      terrainFactory,
      flatTerrainFactory,
    });
    this.course = null;
    this.surfaceAt = null;
    this.treeObstacles = null; // the course's real trees as ball obstacles (null: none)
    this.settings = { gimmeYd: 8, units: 'yd' }; // gimme in feet? keep yards: 2.7yd ~ 8ft
    this.runtimeReady = true; // HD flow flips this false until the matching scene is ready
    this.practice = null;     // a driving range / mini game session (lib/practice.js), or null
    // Playing conditions (lib/conditions.js): wind, air, firmness, green speed. They
    // belong to the day, not the course, so a new course keeps them.
    this.conditions = normalizeConditions(null);
    this.selectedClub = null; // CLUB_FULL key the player picked (POST /api/club), or null
    this.reset();
  }

  // Conditions from a preset id ('windy'), {preset, ...fields} or a partial change.
  // Throws on an unknown preset. Returns the new conditions as the state shows them.
  setConditions(patchOrPresetId) {
    this.conditions = resolveConditions(patchOrPresetId, this.conditions);
    return conditionsState(this.conditions);
  }

  // Remember the club the player picked (UI label or any monitor name); an unknown
  // name leaves the selection as it was. Returns the selected club key.
  setSelectedClub(club) {
    const key = clubKey(club);
    if (key) this.selectedClub = key;
    return this.selectedClub;
  }

  prepareCourse(course, { terrainPatches = [], ready = true } = {}) {
    if (!course || !Array.isArray(course.holes) || course.holes.length === 0) {
      throw new Error('Course has no playable holes');
    }
    for (const hole of course.holes) {
      if (!hole || !Array.isArray(hole.tee) || hole.tee.length !== 2 ||
          !hole.tee.every(Number.isFinite) ||
          !Array.isArray(hole.pin) || hole.pin.length !== 2 ||
          !hole.pin.every(Number.isFinite)) {
        throw new Error('Course has invalid playable hole geometry');
      }
    }
    if (!Array.isArray(terrainPatches)) throw new Error('Terrain patches must be an array');

    const surfaceAt = this._courseFactories.surfaceLookupFactory(course);
    if (typeof surfaceAt !== 'function') throw new Error('Course surface lookup is invalid');
    // Physics samples a lightly-smoothed terrain (per D3): real green borrow
    // survives, sub-metre LIDAR scan noise that would jitter putts does not.
    // Injected HD terrain patches take precedence over the coarse green patches.
    const terrain = course.elevation
      ? this._courseFactories.terrainFactory(
        course.elevation,
        [...terrainPatches, ...(course.elevation.patches || [])],
        { smooth: true },
      )
      : this._courseFactories.flatTerrainFactory();
    if (!terrain || typeof terrain.h !== 'function' || typeof terrain.grad !== 'function') {
      throw new Error('Course terrain sampler is invalid');
    }
    // The trees the renderer draws (canopy + OSM points), indexed once per course.
    // Tied to no terrain: trunk ground heights are sampled per sampler, on demand.
    const treeObstacles = buildTreeObstacles(course);

    const firstHole = course.holes[0];
    return Object.freeze({
      course,
      surfaceAt,
      terrain,
      treeObstacles,
      runtimeReady: Boolean(ready),
      practice: null,   // a new course ends any practice session
      holeIndex: 0,
      over: false,
      scores: course.holes.map(() => null),
      pickedUp: course.holes.map(() => false),
      shotLog: [],
      ball: { x: firstHole.tee[0], y: firstHole.tee[1] },
      strokes: 0,
      lie: 'tee',
      holed: false,
      aimOffset: 0,
    });
  }

  commitPreparedCourse(preparedCourse) {
    for (const field of PREPARED_COURSE_FIELDS) this[field] = preparedCourse[field];
  }

  setCourse(course, options = {}) {
    const preparedCourse = this.prepareCourse(course, options);
    this.commitPreparedCourse(preparedCourse);
  }

  // Rebuild ONLY the terrain sampler from the already-loaded course (e.g. once a
  // coherent HD scene is ready). Never touches hole/scores/ball/aim/round state;
  // unlocks shots.
  activateRuntimeTerrain(terrainPatches = []) {
    if (!this.course) return;
    this.terrain = this.course.elevation
      ? this._courseFactories.terrainFactory(
        this.course.elevation,
        [...terrainPatches, ...(this.course.elevation.patches || [])],
        { smooth: true },
      )
      : this._courseFactories.flatTerrainFactory();
    this.runtimeReady = true;
  }

  reset() {
    this.holeIndex = 0;
    this.over = false;
    this.scores = this.course ? this.course.holes.map(() => null) : [];
    this.pickedUp = this.course ? this.course.holes.map(() => false) : [];
    this.shotLog = [];
    this._setupHole();
  }

  _setupHole() {
    if (!this.course || !this.course.holes.length) return;
    const h = this.hole;
    this.ball = { x: h.tee[0], y: h.tee[1] };
    this.strokes = 0;
    this.lie = 'tee';
    this.holed = false;
    this.aimOffset = 0; // deg, user adjustment relative to straight-at-pin
  }

  get hole() { return this.course ? this.course.holes[this.holeIndex] : null; }

  get aimDeg() {
    const h = this.hole;
    if (!h) return 0;
    const dx = h.pin[0] - this.ball.x, dy = h.pin[1] - this.ball.y;
    return (Math.atan2(dx, dy) * 180 / Math.PI) + this.aimOffset;
  }

  get distToPinYd() {
    const h = this.hole;
    if (!h) return 0;
    return Math.hypot(h.pin[0] - this.ball.x, h.pin[1] - this.ball.y) / YD;
  }

  // ---------- practice (driving range, mini games) ----------
  // A session plays on this course's physics but leaves the round untouched. Putting
  // and chipping play on the green of the hole the round is on, unless told otherwise.
  startPractice(mode, options = {}) {
    if (!this.course) throw new Error('Load a course first');
    const hole = options.hole ?? (mode === 'putting' || mode === 'chipping' ? this.holeIndex : null);
    this.practice = new PracticeSession({
      course: this.course, surfaceAt: this.surfaceAt, terrain: this.terrain, treeObstacles: this.treeObstacles,
      conditions: this.conditions,
    }, { ...options, hole, mode });
    return this.practice;
  }

  endPractice() { this.practice = null; }

  setAimOffset(offset) {
    const v = Math.max(-45, Math.min(45, +offset || 0));
    if (this.practice) this.practice.setAim(v);
    else this.aimOffset = v;
  }

  /** Handle launch monitor ball data. Returns a shot result for broadcasting. */
  handleShot(ball, clubName) {
    if (!this.course || !this.runtimeReady) return null;
    if (!this.practice && (this.holed || this.over)) return null;
    // Validate + sanitize so one bad packet can't brick the round.
    const launch = launchFromBall(ball);
    if (!launch) {
      console.warn(`[game] ignoring shot — invalid ball speed: ${JSON.stringify((ball || {}).Speed)}`);
      return null;
    }
    let result;
    if (this.practice) {
      // the terrain (HD) and the conditions may have changed since the session began
      this.practice.ctx.terrain = this.terrain;
      this.practice.ctx.conditions = this.conditions;
      result = this.practice.play(launch, clubName || null);
    } else {
      result = this._play(launch);
      if (result) result.club = clubName || null;   // real club type from the monitor, if known
    }
    // the club as a CLUB_FULL key: the monitor's, else the player's pick (null: unknown)
    if (result) result.clubKey = shotClubKey(clubName, this.selectedClub);
    return result;
  }

  _play(launch) {
    const h = this.hole;
    const from = { ...this.ball };
    const sim = simulateShot(launch, from, this.aimDeg, this.surfaceAt, {
      terrain: this.terrain,
      pin: { x: h.pin[0], y: h.pin[1] },
      trees: this.treeObstacles,
      ...physicsOptions(this.conditions, { gust: true }),   // standard conditions: the standard physics
    });
    this.strokes++;

    let penalty = 0;
    let note = '';
    let end = sim.end;
    let endSurface = sim.endSurface;

    const water = sim.events.find((e) => e.type === 'water');
    if (water || endSurface === 'water') {
      penalty = 1;
      // red/lateral relief: drop near where the ball crossed the edge
      const cx = water ? water.x : end.x, cy = water ? water.y : end.y;
      end = this._lateralDrop(cx, cy, h.pin, from);
      endSurface = this.surfaceAt(end.x, end.y);
      note = 'Water — lateral drop (+1)';
    } else if (endSurface === 'ob') {
      penalty = 1;
      // drop-and-go: drop where the ball last left the playable area
      let drop = from;
      for (const p of sim.points) {
        if (this.surfaceAt(p.x, p.y) === 'ob') break;
        drop = { x: p.x, y: p.y };
      }
      end = drop;
      endSurface = this.surfaceAt(end.x, end.y);
      note = 'Out of bounds — drop where it left (+1)';
    }

    this.strokes += penalty;
    this.ball = { x: end.x, y: end.y };
    this.lie = endSurface;

    // holed out? real cup capture during the roll, or gimme when stopped close
    const distPinYd = Math.hypot(h.pin[0] - end.x, h.pin[1] - end.y) / YD;
    if (sim.holed && !penalty) {
      this.holed = true;
      this.ball = { x: h.pin[0], y: h.pin[1] };
      note = 'In the hole!';
      this._scoreHole(this.strokes, false);
    } else if (!penalty && distPinYd * 3 <= this.settings.gimmeYd &&
               (sim.isPutt || endSurface === 'green')) {
      this.strokes++; // concede the tap-in
      note = note || `Gimme inside ${this.settings.gimmeYd} ft (+1)`;
      this.holed = true;
      this._scoreHole(this.strokes, false);
    }

    const result = {
      hole: this.holeIndex + 1,
      strokes: this.strokes,
      launch,
      sim: {
        points: sim.points,
        carryYd: +sim.carryYd.toFixed(1),
        totalYd: +sim.totalYd.toFixed(1),
        offlineYd: +sim.offlineYd.toFixed(1),
        apexFt: +sim.apexFt.toFixed(0),
        flightTime: +sim.flightTime.toFixed(2),
        isPutt: sim.isPutt,
        events: sim.events,
      },
      from,
      end: this.ball,
      lie: this.lie,
      distToPinYd: +this.distToPinYd.toFixed(1),
      penalty,
      holed: this.holed,
      note,
      wind: shotWind(sim, this.conditions),   // the wind this ball met, gust included
    };
    this.shotLog.push({ hole: result.hole, strokes: this.strokes, carry: result.sim.carryYd });
    return result;
  }

  // Red penalty-area relief: nearest dry, in-bounds spot within ~2 club-lengths
  // of where the ball crossed the edge, no nearer the hole. Falls back to
  // back-on-the-line (straight away from the pin), then to replaying from the
  // previous spot — so the ball is never stranded in water/OB.
  _lateralDrop(cx, cy, pin, from) {
    const TWO_CL = 2.3; // ~2 club-lengths, m
    const dPin = Math.hypot(pin[0] - cx, pin[1] - cy) || 1;
    const playable = (x, y) => {
      const s = this.surfaceAt(x, y);
      return s !== 'water' && s !== 'ob';
    };
    for (let r = 0.6; r <= TWO_CL; r += 0.6) {
      for (let a = 0; a < 360; a += 30) {
        const x = cx + Math.cos(a * Math.PI / 180) * r;
        const y = cy + Math.sin(a * Math.PI / 180) * r;
        if (Math.hypot(pin[0] - x, pin[1] - y) >= dPin && playable(x, y)) return { x, y };
      }
    }
    const ux = (cx - pin[0]) / dPin, uy = (cy - pin[1]) / dPin;
    for (let d = 0.6; d <= 60; d += 0.6) {
      const x = cx + ux * d, y = cy + uy * d;
      if (playable(x, y)) return { x, y };
    }
    return from; // last resort: replay from the previous spot (always playable)
  }

  // Record the current hole's score, flag a concession, and end the round if it
  // was the final hole. Single place round-over is decided from a score write —
  // shared by the holed/gimme path in _play and the pick-up/skip path below.
  _scoreHole(strokes, pickedUp) {
    this.scores[this.holeIndex] = strokes;
    this.pickedUp[this.holeIndex] = pickedUp;
    if (this.holeIndex === this.course.holes.length - 1) this.over = true;
  }

  nextHole() {
    if (!this.course || this.over || this.practice) return; // round finished / paused for practice
    if (!this.holed) {
      // pick up (hacked it around) -> honest count; skip (never swung) -> "did not play"
      const s = this.strokes > 0 ? this.strokes + 1 : this.hole.par + 2;
      this._scoreHole(s, true);
    }
    if (this.over) return;                         // that was the last hole — don't advance
    this.holeIndex++;
    this._setupHole();
  }

  state() {
    if (!this.course) return { loaded: false, conditions: conditionsState(this.conditions), selectedClub: this.selectedClub };
    const round = this._roundState();
    if (!this.practice) return round;
    // Practice: the scene follows the session's spot and target; the round's
    // own numbers stay in the state for the scorecard.
    const p = this.practice;
    const toTargetYd = Math.hypot(p.target.x - p.spot[0], p.target.y - p.spot[1]) / YD;
    return {
      ...round,
      ball: { x: p.spot[0], y: p.spot[1] },
      tee: p.greenGame ? null : p.spot,   // no tee markers on or round a green
      pin: [p.target.x, p.target.y],
      lie: p.lie,
      holed: false,
      aimDeg: +p.aimDeg.toFixed(1),
      aimOffset: p.aimOffset,
      distToPinYd: +toTargetYd.toFixed(1),
      practice: p.state(),
    };
  }

  _roundState() {
    const h = this.hole;
    return {
      loaded: true,
      courseName: this.course.name,
      holeCount: this.course.holes.length,
      hole: this.holeIndex + 1, // play position (1..N) — drives pills/nav/scores
      holeRef: h.ref,           // the REAL course hole number (1,9,10,18…) — what the player should see
      holeRefs: this.course.holes.map((x) => x.ref),
      par: h.par,
      lengthYd: h.lengthYd,
      ball: this.ball,
      lie: this.lie,
      strokes: this.strokes,
      holed: this.holed,
      aimDeg: +this.aimDeg.toFixed(1),
      aimOffset: this.aimOffset,
      distToPinYd: +this.distToPinYd.toFixed(1),
      pin: h.pin,
      tee: h.tee,
      scores: this.scores,
      pickedUp: this.pickedUp,
      over: this.over,
      pars: this.course.holes.map((x) => x.par),
      settings: this.settings,
      runtimeReady: this.runtimeReady,
      conditions: conditionsState(this.conditions),   // values + presetId + airDensity
      selectedClub: this.selectedClub,
    };
  }
}

module.exports = { Game, CLUB_FULL, clubKey, shotClubKey, launchFromBall };
