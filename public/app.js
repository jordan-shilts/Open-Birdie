// Open-Birdie UI glue: SSE <-> HUD <-> 3D scene.
import { GolfScene } from './render/scene.js';
import { loadHdBundle } from './render/hd-bundle.js';
import { buildHdAckEvidence, validateHdPolicy, waitForCaptureReady } from './render/capture-readiness.js';
import { toPar, forwardLabel, verdict } from './scoring.mjs';
import { FlightView } from './flight-view.js';
import { AimMap } from './aim-map.js';
import { ConditionsUI } from './conditions-ui.js';
import { Lineup, clubByLabel, writeAutoClub } from './lineup.js';
import { parseQualitySetting, qualityLabel } from './render/quality.js';
import { parseSkySetting, SKY_ORDER, SKY_PRESETS } from './render/sky-presets.js';

const $ = (id) => document.getElementById(id);
// Readiness nonce handed only to the loopback Electron primary client (absent on LAN mirrors).
const query = new URLSearchParams(location.search);
const primaryNonce = query.get('primaryNonce') || '';
const visualCaptureEnabled = query.get('visualCapture') === '1';
// Graphics quality: ?gfx=auto|high|low overrides the saved choice (Auto by default).
// Visual-capture runs pin High and never auto-downshift, so frames stay comparable.
const GFX_KEY = 'open-birdie.graphics';
const readGfx = () => { try { return localStorage.getItem(GFX_KEY); } catch { return null; } };
let gfxSetting = parseQualitySetting(query.get('gfx') || (visualCaptureEnabled ? 'high' : readGfx()) || 'auto');
// Time of day: ?sky=morning|midday|golden overrides the saved choice (Midday by default;
// visual capture pins Midday unless asked).
const SKY_KEY = 'open-birdie.sky';
const readSky = () => { try { return localStorage.getItem(SKY_KEY); } catch { return null; } };
let skySetting = parseSkySetting(query.get('sky') || (visualCaptureEnabled ? 'midday' : readSky()));
const scene = new GolfScene($('scene'), { quality: gfxSetting, autoQuality: !visualCaptureEnabled, sky: skySetting });
const flightView = new FlightView($('flightview'));

// ---------- HUD scale: one layout, zoomed to the window (laptop .. 4K TV) ----------
function fitHud() {
  const w = window.innerWidth, h = window.innerHeight;
  const z = w <= 700 ? 1 : Math.max(0.72, Math.min(1.45, Math.min(w / 1680, h / 945)));
  $('hud').style.zoom = z.toFixed(3);
}
fitHud();
window.addEventListener('resize', fitHud);

// segmented control in the menu: [[value, label]], the current value, pick(value)
function segmented(el, options, current, pick) {
  el.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.value = value;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', value === current ? 'true' : 'false');
    b.onclick = () => pick(value);
    el.appendChild(b);
  }
}
const markSeg = (el, value) => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.value === value ? 'true' : 'false'));
function showGfx(q) {
  markSeg($('seg-gfx'), gfxSetting);
  $('seg-gfx').title = `Graphics: ${qualityLabel(q.setting, q.level)} (${q.reason})`;
}
segmented($('seg-gfx'), [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']], gfxSetting, (v) => {
  gfxSetting = parseQualitySetting(v);
  try { localStorage.setItem(GFX_KEY, gfxSetting); } catch { /* private mode */ }
  scene.setQuality(gfxSetting);
  showGfx(scene.quality);
});
scene.onQualityChange = showGfx;
showGfx(scene.quality);
segmented($('seg-sky'), SKY_ORDER.map((k) => [k, k === 'golden' ? 'Golden' : SKY_PRESETS[k].label]), skySetting, (v) => {
  skySetting = parseSkySetting(v);
  try { localStorage.setItem(SKY_KEY, skySetting); } catch { /* private mode */ }
  markSeg($('seg-sky'), skySetting);
  // a sky that can't be fetched falls back to midday: show what actually loaded
  scene.setSky(skySetting).then(() => { skySetting = scene.skySetting; markSeg($('seg-sky'), skySetting); });
});

// ---------- lining up: conditions, aim map, prediction ----------
const conditions = new ConditionsUI({ onOpen: () => closeMenu() });
const aimMap = new AimMap($('aim-canvas'), {
  onAim: (v) => lineup.setAim(v, { commit: false }),
  onAimEnd: (v) => lineup.setAim(v),
});
const lineup = new Lineup({
  scene, flightView, aimMap, conditions,
  onClubChange: (key) => { const p = clubPresets[key]; if (p) setPractice(p.speedMph, p.vla, p.spin); },
});
window.__birdie = { scene, lineup, get state() { return state; } };
segmented($('seg-autoclub'), [['on', 'On'], ['off', 'Off']], lineup.autoClub ? 'on' : 'off', (v) => {
  lineup.autoClub = v === 'on';
  writeAutoClub(lineup.autoClub);
  markSeg($('seg-autoclub'), v);
});

let state = null;
let pendingState = null;
let animating = false;
let lastHoleKey = '';
let clubPresets = {};
let prevOver = false;   // round-over auto-open latch (open the card once, not every state event)
let reviewHole = null;  // index of a played hole being reviewed on the scorecard
let captureCourse = null;
let captureHd = {
  advertisedIds: [], loadedIds: [], ackRequestIds: [], acknowledgedIds: [], failures: [], ack: null,
};
let captureFonts = { state: visualCaptureEnabled ? 'loading' : 'not-requested' };
if (visualCaptureEnabled) {
  if (!document.fonts?.ready) {
    captureFonts = { state: 'unsupported' };
  } else {
    Promise.resolve(document.fonts.ready).then(
      () => { captureFonts = { state: 'ready' }; },
      (error) => {
        captureFonts = { state: 'failed', error: error?.message || String(error) };
        console.error('[visual-capture] font settlement failed', error);
      },
    );
  }
}

// ---------- state application ----------
// The HUD stat tiles: the round's labels, or a practice session's.
function setStat(id, label, value) {
  $(id).previousElementSibling.textContent = label;
  $(id).textContent = value;
}
const PRACTICE_SHORT = { range: 'RANGE', closest: 'CTP', longdrive: 'LONG', targets: 'TARGET', putting: 'PUTTS', chipping: 'CHIPS', ladder: 'LADDER' };
// putting and chipping: games at a real hole's cup, from a new spot round it every ball
const greenGame = (pr) => pr.mode === 'putting' || pr.mode === 'chipping';

function applyState(s) {
  state = s;
  if (!s.loaded) { openCourseModal(); return; }
  const pr = s.practice || null;   // driving range / mini game session (the round is paused)
  $('course-name').textContent = s.courseName.split(',')[0];
  if (pr) {
    const closest = pr.mode === 'closest' && pr.holeRef != null;
    const green = greenGame(pr);
    setStat('hud-hole', closest ? 'HOLE' : 'MODE', closest ? `${pr.holeRef}` : PRACTICE_SHORT[pr.mode]);
    setStat('hud-par', green ? 'HOLE' : 'PAR', green ? `${pr.holeRef}` : closest ? '3' : '–');
    setStat('hud-len', green ? 'TO CUP' : 'FLAG', !green ? `${pr.target.yd}y`
      : pr.mode === 'putting' ? `${Math.round(s.distToPinYd * 3)} ft` : `${Math.round(s.distToPinYd)}y`);
    setStat('hud-strokes', 'BALLS', pr.ballsTotal ? `${pr.ballsHit}/${pr.ballsTotal}` : `${pr.ballsHit}`);
  } else {
    setStat('hud-hole', 'HOLE', `${s.holeRef ?? s.hole}`); // real course hole number (1,9,10,18…), not play index
    setStat('hud-par', 'PAR', s.par);
    setStat('hud-len', 'LENGTH', `${s.lengthYd}y`);
    setStat('hud-strokes', 'STROKES', s.strokes);
  }
  updateForward(s);
  if (!lineup._dragging) {
    $('aim-slider').value = s.aimOffset;
    $('aim-val').textContent = `${s.aimOffset > 0 ? 'R' : s.aimOffset < 0 ? 'L' : ''}${Math.abs(s.aimOffset).toFixed(1)}°`;
  }
  updateScoreChip(s);
  updateHolePills(s);

  // a practice target is its own "hole": a new flag, or a new ball round the green,
  // re-frames the shot from behind the ball
  const key = pr
    ? `${s.courseName}#${pr.mode}@${s.pin[0].toFixed(1)},${s.pin[1].toFixed(1)}<${s.ball.x.toFixed(1)},${s.ball.y.toFixed(1)}`
    : `${s.courseName}#${s.hole}`;
  if (scene.geo) {
    if (key !== lastHoleKey) {
      lastHoleKey = key;
      flightView.newHole(key);
      // the flag reads its yardage on the range, its hole number at a real cup
      scene.setHole({ pin: s.pin, tee: s.tee, ref: pr ? (pr.target.yd ?? pr.holeRef) : (s.holeRef ?? s.hole) }, { x: s.ball.x, y: s.ball.y }, s.aimDeg);
    } else if (!animating) {
      scene.setBall(s.ball);
      scene.setAim(s.aimDeg);
    }
    scene.setPracticeFlags(pr ? pr.flags.filter((f) => f.yd !== pr.target.yd) : []);
    scene.setPracticeGrid(pr && pr.grid
      ? { from: pr.spot, to: s.pin, halfWidth: pr.grid.halfWidthYd * 0.9144, lengthM: 360 }
      : null);
  }
  if (scene.geo) lineup.setState(s);
  buildScorecard(s);
  renderPracticeBoard(s);
  stackShotPanel();

  // round-over: auto-open the card exactly once (latched on the false->true edge), and
  // lock out further play. Lives here so the pendingState/animation path triggers it too.
  if (s.over && !prevOver && !pr) { $('scorecard').classList.remove('hidden'); $('practice').classList.add('hidden'); }
  prevOver = s.over;
  $('btn-practice').classList.toggle('hidden', !!s.over && !pr);
}

async function loadGeometry() {
  const geo = await (await fetch('/api/course-geometry')).json();
  if (!geo || !geo.name) return;
  captureCourse = { name: geo.name, revision: geo.courseRevision };
  // geo.hd is an ARRAY of bundle metadata (one per built hole) or null. Load each;
  // a single failed bundle just drops that one hole's HD relief, not the rest.
  const metas = Array.isArray(geo.hd) ? geo.hd : (geo.hd ? [geo.hd] : []);
  captureHd = {
    advertisedIds: metas.map((meta) => meta.bundleId),
    loadedIds: [],
    ackRequestIds: [],
    acknowledgedIds: [],
    failures: [],
    ack: null,
  };
  let hdAssets = [];
  if (metas.length) {
    const loaded = await Promise.all(metas.map(async (meta) => {
      try {
        return {
          asset: await loadHdBundle(meta, {
            imageDecoder: (bytes, opts) => createImageBitmap(new Blob([bytes]), opts),
            expectedRevision: geo.courseRevision,
          }),
          meta,
          error: null,
        };
      } catch (error) {
        console.warn('[hd] bundle load failed — skipping hole', meta && meta.hole, error && error.message);
        return { asset: null, meta, error: error?.message || String(error) };
      }
    }));
    hdAssets = loaded.map((entry) => entry.asset).filter(Boolean);
    captureHd.loadedIds = loaded.filter((entry) => entry.asset).map((entry) => entry.meta.bundleId);
    captureHd.failures = loaded.filter((entry) => entry.error).map((entry) => ({
      bundleId: entry.meta?.bundleId || null,
      hole: entry.meta?.hole || null,
      message: entry.error,
    }));
  }
  const mode = hdAssets.length ? 'hd' : 'procedural';
  scene.loadCourse(geo, { hdAssets });
  aimMap.setCourse(geo);
  if (visualCaptureEnabled) await scene.compileVisualCaptureShaders();
  lastHoleKey = '';
  if (state) applyState(state);
  // Acknowledge readiness so the server activates the matching physics. HD courses are
  // held at runtimeReady:false until this; plain courses are already ready. The ack
  // names the FULL advertised bundle set (the server requires the exact active set);
  // physics is server-side, so it stays HD even if a client texture decode failed.
  if (metas.length) {
    const requestedBundleIds = metas.map((meta) => meta.bundleId);
    captureHd.ackRequestIds = [...requestedBundleIds];
    try {
      const response = await fetch('/api/course-runtime-ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseRevision: geo.courseRevision, bundleIds: requestedBundleIds, mode, primaryNonce }),
      });
      captureHd.ack = await response.json();
      Object.assign(captureHd, buildHdAckEvidence(requestedBundleIds, captureHd.ack));
    } catch (e) {
      captureHd.ack = { ok: false, error: e?.message || String(e) };
      Object.assign(captureHd, buildHdAckEvidence(requestedBundleIds, captureHd.ack));
      /* LAN mirror / transient — the server's readiness timeout covers it */
    }
  }
}

if (query.get('visualCapture') === '1') {
  window.__birdie.visualCapture = Object.freeze({
    status() {
      const render = scene.visualCaptureStatus();
      return {
        course: captureCourse,
        runtimeReady: !!state?.runtimeReady,
        environment: render.environment,
        loader: render.loader,
        hd: JSON.parse(JSON.stringify(captureHd)),
        fonts: { ...captureFonts },
        shaderCompile: render.shaderCompile,
        postfx: render.postfx,
      };
    },
    waitUntilReady(options = {}) {
      return waitForCaptureReady({
        ...options,
        status: () => this.status(),
        nextFrame: () => new Promise((resolve) => requestAnimationFrame(resolve)),
      });
    },
    applyFrame(frame) {
      return scene.renderVisualCaptureStill(frame);
    },
    canvasPng() {
      return scene.renderer.domElement.toDataURL('image/png');
    },
    diagnostics(options = {}) {
      return { ...this.status(), scene: scene.visualCaptureDiagnostics(options) };
    },
    samplePerformance(options = {}) {
      return scene.sampleVisualCapturePerformance(options);
    },
    vegetationTextureChecksums() {
      return scene.visualCaptureVegetationChecksums();
    },
    validateHdPolicy(policy) {
      return validateHdPolicy(captureHd, policy);
    },
  });
}

// ---------- SSE ----------
const es = new EventSource('/events');
es.addEventListener('state', (e) => {
  const s = JSON.parse(e.data);
  if (animating) pendingState = s;
  else applyState(s);
});
es.addEventListener('course', () => { loadGeometry(); closeCourseModal(); });
// Scenery (buildings, real trees, the aerial photo) can arrive after the course is
// playable. Same activation, so the HD assets and the round stay: re-read the
// geometry and rebuild the scene in place (deferred by the scene while a shot flies).
let sceneryTimer = null;
es.addEventListener('scenery', (e) => {
  const info = JSON.parse(e.data);
  clearTimeout(sceneryTimer);
  sceneryTimer = setTimeout(() => { refreshScenery(info).catch((err) => console.warn('[scenery] refresh failed', err)); }, 400);
});
async function refreshScenery(info) {
  if (!scene.geo || !captureCourse || info.courseRevision !== captureCourse.revision) return;
  const geo = await (await fetch('/api/course-geometry')).json();
  if (!geo || geo.courseRevision !== captureCourse.revision) return; // a newer course took over
  if (typeof scene._rebuildScenery !== 'function') { await loadGeometry(); return; }
  scene.geo = geo;
  scene._rebuildScenery();
}
// Progress of a cloud download/build (shown in the course picker while a pick is in
// flight) and of background scenery (a small status line over the course).
let pickInFlight = false;
let statusHide = null;
es.addEventListener('course-progress', (e) => {
  const p = JSON.parse(e.data);
  const text = p.message ? `${p.message}${Number.isFinite(p.pct) ? ` ${Math.round(p.pct)}%` : ''}` : '';
  if (pickInFlight && p.stage !== 'scenery') {
    if (!text) return;
    const msg = $('course-msg');
    msg.className = 'muted';
    msg.innerHTML = '<span class="loading-spin"></span>';
    msg.append(text); // text node: never markup from the server
    return;
  }
  const el = $('course-status');
  clearTimeout(statusHide);
  if (p.done || !text) { statusHide = setTimeout(() => el.classList.add('hidden'), 1200); return; }
  el.textContent = text;
  el.classList.remove('hidden');
});
es.addEventListener('lm', (e) => {
  const lm = JSON.parse(e.data);
  $('lm-status').classList.toggle('connected', lm.connected);
  $('lm-text').textContent = lm.connected ? 'Monitor connected' : 'Monitor offline';
});
let lineupBack = null;   // after a shot lands: back to lining up the next one
es.addEventListener('shot', (e) => {
  const shot = JSON.parse(e.data);
  const plan = lineup.pred;   // what this club was predicted to do, for the comparison
  showShotData(shot, plan);
  animating = true;
  clearTimeout(lineupBack);
  lineup.setFlying(true);
  flightView.startShot(shot);
  const treeCallout = treeCalloutFor(shot);
  const pts = shot.sim.points || [];
  let shown = 0;
  scene.playShot(shot.sim.points, shot.sim.flightTime, () => {
    animating = false;
    flightView.finish();
    aimMap.setShot(pts);
    lineup.setFlying(false);
    if (pendingState) { applyState(pendingState); pendingState = null; }
    shotToast(shot);
    lineupBack = setTimeout(() => flightView.lineup(), 4200);
  }, {
    onProgress: (t) => {
      flightView.setTime(t);
      treeCallout(t);
      // the map traces the ball, a few times a second
      let i = shown;
      while (i < pts.length && pts[i].t <= t) i++;
      if (i - shown >= 6 || (i === pts.length && shown !== i)) { shown = i; aimMap.setShot(pts.slice(0, i)); }
    },
    isPutt: !!shot.sim.isPutt,
  });
});

function setVal(id, num, unit) {
  $(id).innerHTML = unit ? `${num}<small>${unit}</small>` : `${num}`;
}
// Infer the club from ball speed so the HUD reflects what was actually hit
// (launch monitors report ball data, not club; auto-play uses this too).
function clubFromShot(speedMph, isPutt) {
  if (isPutt) return 'PT';
  const t = [[158, 'DR'], [147, '3W'], [138, '3H'], [130, '4i'], [123, '5i'],
            [115, '6i'], [107, '7i'], [99, '8i'], [88, '9i'], [70, 'PW'], [50, 'SW']];
  for (const [min, c] of t) if (speedMph >= min) return c;
  return 'LW';
}
// Map a launch-monitor club name (e.g. "DRIVER", "WOOD5", "IRON7") to a short HUD label.
function prettyClub(name) {
  const s = String(name).toUpperCase().replace(/[\s_]/g, '');
  if (/DRIVER|^1W$/.test(s)) return 'DR';
  if (/PUTTER|^PUTT$/.test(s)) return 'PT';
  let m;
  if ((m = s.match(/(?:WOOD|^W)(\d+)/))) return m[1] + 'W';
  if ((m = s.match(/(?:HYBRID|UTILITY|^H|^U)(\d+)/))) return m[1] + 'H';
  if ((m = s.match(/(?:IRON|^I)(\d+)/))) return m[1] + 'i';
  if (/PITCH|^PW$|WEDGEP/.test(s)) return 'PW';
  if (/SAND|^SW$|WEDGES/.test(s)) return 'SW';
  if (/LOB|^LW$|WEDGEL/.test(s)) return 'LW';
  if (/GAP|APPROACH|^GW$|^AW$|WEDGEA|WEDGEG/.test(s)) return 'GW';
  return name;   // unknown — show the monitor's label as-is
}
function showShotData(shot, plan = null) {
  $('shotpanel').classList.remove('hidden');
  const l = shot.launch, sim = shot.sim;
  const club = shot.club ? prettyClub(shot.club) : clubFromShot(l.speedMph, sim.isPutt);
  lineup.markClubLabel(club);
  $('sp-club').textContent = clubByLabel(club)?.name || club;
  setVal('sd-speed', l.speedMph.toFixed(1), 'mph');
  setVal('sd-launch', `${l.vla.toFixed(1)}° ${l.hla > 0 ? 'R' : l.hla < 0 ? 'L' : ''}${Math.abs(l.hla).toFixed(1)}°`, '');
  setVal('sd-spin', Math.round(l.totalSpin), 'rpm');
  setVal('sd-axis', `${l.spinAxis > 0 ? 'R' : l.spinAxis < 0 ? 'L' : ''}${Math.abs(l.spinAxis).toFixed(1)}°`, '');
  setVal('sd-carry', sim.isPutt ? '—' : sim.carryYd.toFixed(0), sim.isPutt ? '' : 'yd');
  setVal('sd-total', sim.isPutt ? (sim.totalYd * 3).toFixed(0) : sim.totalYd.toFixed(0), sim.isPutt ? 'ft' : 'yd');
  setVal('sd-offline', `${sim.offlineYd > 0 ? 'R' : sim.offlineYd < 0 ? 'L' : ''}${Math.abs(sim.offlineYd).toFixed(0)}`, 'yd');
  setVal('sd-apex', sim.isPutt ? '—' : sim.apexFt.toFixed(0), sim.isPutt ? '' : 'ft');
  // against the plan: how far past / short of the predicted carry, and which side
  const vs = $('sd-vs');
  if (plan && !plan.isPutt && !sim.isPutt && Number.isFinite(plan.carryYd)) {
    const dc = Math.round(sim.carryYd - plan.carryYd);
    const off = Math.round(sim.offlineYd - plan.offlineYd);
    vs.innerHTML = `vs plan: <b class="${dc >= 0 ? 'up' : 'down'}">${dc >= 0 ? '+' : '−'}${Math.abs(dc)} yd</b> carry`
      + (Math.abs(off) >= 1 ? `, <b>${Math.abs(off)} yd ${off > 0 ? 'right' : 'left'}</b> of the line` : ', on line');
  } else vs.innerHTML = '';
  stackShotPanel();
}

// While a game is on, the last shot's numbers stack under its board in the left column,
// and step aside when the board leaves them no room above the shot card.
function stackShotPanel() {
  const panel = $('shotpanel'), board = $('practice-board');
  const on = !board.classList.contains('hidden');
  panel.classList.remove('no-room');
  panel.style.top = on ? `${board.offsetTop + board.offsetHeight + 8}px` : '';
  if (on && panel.offsetTop + panel.offsetHeight > $('shot-card').offsetTop - 8) panel.classList.add('no-room');
}

function shotToast(shot) {
  if (shot.practice) { practiceToast(shot); return; }
  let main, sub = shot.note || '';
  if (shot.holed) {
    const par = state?.par ?? 4;
    const diff = shot.strokes - par;
    const names = { '-3': 'ALBATROSS!', '-2': 'EAGLE!', '-1': 'BIRDIE!', 0: 'Par', 1: 'Bogey', 2: 'Double bogey' };
    main = `⛳ ${names[diff] ?? (diff > 0 ? `+${diff}` : 'Holed!')} — ${shot.strokes} strokes`;
  } else if (shot.sim.isPutt) {
    main = `${(shot.sim.totalYd * 3).toFixed(0)} ft putt`;
  } else {
    main = `Carry ${shot.sim.carryYd.toFixed(0)} · Total ${shot.sim.totalYd.toFixed(0)} yd`;
    if (!sub) sub = `${shot.sim.offlineYd > 0 ? 'R' : 'L'}${Math.abs(shot.sim.offlineYd).toFixed(0)} yd ${shot.lie === 'ob' ? '' : '· lie: ' + shot.lie}`;
  }
  showToast(main, sub);
}

function showToast(main, sub = '') {
  const t = $('toast');
  t.innerHTML = `${esc(main)}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
  t.classList.remove('hidden');
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; }, 4200);
}

// "Tree!" the moment the replay reaches the ball's first tree contact (a `tree` sim
// event: part 'trunk' or 'crown'). Returns the per-frame replay-time hook.
function treeCalloutFor(shot) {
  const hit = (shot.sim.events || []).find((ev) => ev.type === 'tree');
  let shown = !hit;
  return (t) => {
    if (shown || t < hit.t) return;
    shown = true;
    showToast('🌳 Tree!', hit.part === 'trunk' ? 'Off the trunk' : 'Into the branches');
  };
}

// ---------- HUD chips ----------
const FWD_ARIA = {
  'Pick up': 'Pick up this hole and go to the next',
  Skip: 'Skip this hole and go to the next',
  'Next hole': 'Go to the next hole',
  'Finish round': 'Finish the round and see the scorecard',
};
function updateForward(s) {
  const f = forwardLabel(s);
  const btn = $('btn-next');
  btn.classList.toggle('hidden', !!f.hidden || !!s.practice);
  if (f.label) { btn.textContent = `${f.label} ▶`; btn.setAttribute('aria-label', FWD_ARIA[f.label] || f.label); }
}
function updateScoreChip(s) {
  const t = toPar(s.scores, s.pars);
  const chip = $('score-chip');
  chip.textContent = t === 0 ? 'E' : t > 0 ? `+${t}` : `${t}`;
  chip.classList.toggle('under', t < 0);
  chip.classList.toggle('over', t > 0);
}

function updateHolePills(s) {
  const el = $('hole-pills');
  el.classList.toggle('hidden', !!s.practice);
  if (el.children.length !== s.holeCount) {
    el.innerHTML = '';
    for (let i = 1; i <= s.holeCount; i++) {
      const p = document.createElement('button');
      p.className = 'pill'; p.textContent = (s.holeRefs && s.holeRefs[i - 1]) ?? i; p.dataset.h = i; p.type = 'button';
      p.onclick = () => reviewHoleOnCard(+p.dataset.h);
      el.appendChild(p);
    }
  }
  for (const p of el.children) {
    const h = +p.dataset.h;
    const ref = (s.holeRefs && s.holeRefs[h - 1]) ?? h; // real hole number for labels
    const done = s.scores[h - 1] != null;
    p.classList.toggle('active', h === s.hole);
    p.classList.toggle('done', done);
    p.classList.toggle('pickedup', !!(s.pickedUp && s.pickedUp[h - 1]));
    p.disabled = !done && h !== s.hole; // only played holes (and the current one) are reachable
    p.setAttribute('aria-label', done ? `Hole ${ref}, score ${s.scores[h - 1]}` : `Hole ${ref}`);
    if (h === s.hole) p.setAttribute('aria-current', 'true'); else p.removeAttribute('aria-current');
  }
}

// Review a played hole: open the scorecard and highlight that hole's column.
// (E1 — review is the scorecard, not a shot replay or a camera move.)
function reviewHoleOnCard(h) {
  if (!state || state.scores[h - 1] == null) return;
  reviewHole = h - 1;
  $('scorecard').classList.remove('hidden');
  buildScorecard(state);
}

// ---------- scorecard ----------
function buildScorecard(s) {
  const n = s.pars.length;
  let h1 = '<tr><th></th>', p1 = '<tr><th>Par</th>', s1 = '<tr><th>Score</th>';
  for (let i = 0; i < n; i++) {
    const hl = i === reviewHole ? ' review' : '';
    h1 += `<th class="${hl.trim()}">${i + 1}</th>`;
    p1 += `<td class="${hl.trim()}">${s.pars[i]}</td>`;
    const sc = s.scores[i];
    const cls = sc == null ? '' : sc < s.pars[i] ? 'under' : sc > s.pars[i] ? 'over' : '';
    const dot = (s.pickedUp && s.pickedUp[i]) ? '<i class="pu" title="picked up"></i>' : '';
    s1 += `<td class="${(cls + hl).trim()}">${sc ?? ''}${dot}</td>`;
  }
  const totPar = s.pars.reduce((a, b) => a + b, 0);
  const totScore = s.scores.reduce((a, b) => a + (b || 0), 0);
  $('score-table').innerHTML =
    `<table>${h1}<th>Σ</th></tr>${p1}<td>${totPar}</td></tr>${s1}<td>${totScore || ''}</td></tr></table>`;
  buildSummary(s);
}

function nineRel(s, a, b) {
  let sc = 0, pr = 0;
  for (let i = a; i < b; i++) { pr += s.pars[i]; if (s.scores[i] != null) sc += s.scores[i]; }
  return { sc, rel: sc - pr };
}
function relTxt(rel) { return rel === 0 ? 'E' : rel > 0 ? `+${rel}` : `${rel}`; }

function highlights(s) {
  let eagles = 0, birdies = 0, best = null, bestRel = 99;
  for (let i = 0; i < s.scores.length; i++) {
    const sc = s.scores[i]; if (sc == null) continue;
    const rel = sc - s.pars[i];
    if (rel <= -2) eagles++; else if (rel === -1) birdies++;
    if (rel < bestRel) { bestRel = rel; best = i + 1; }
  }
  const chips = [];
  if (eagles) chips.push(`<span class="sum-chip good">${eagles} eagle${eagles > 1 ? 's' : ''}+</span>`);
  if (birdies) chips.push(`<span class="sum-chip good">${birdies} birdie${birdies > 1 ? 's' : ''}</span>`);
  if (!eagles && !birdies) chips.push('<span class="sum-chip">No birdies this round</span>');
  if (best != null) chips.push(`<span class="sum-chip">Best: hole ${best}</span>`);
  return `<div class="sum-hi">${chips.join('')}</div>`;
}

// Round-complete header (D4 calm payoff): hero to-par + verdict, nines (18 only),
// highlights. Reuses the same #scorecard panel (D5), shown only when the round is over.
function buildSummary(s) {
  const el = $('score-summary');
  $('btn-restart').textContent = s.over ? 'New round' : 'Restart round';
  $('btn-changecourse').classList.toggle('hidden', !s.over);
  $('score-title').classList.toggle('hidden', !!s.over);
  if (!s.over) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const t = toPar(s.scores, s.pars);
  const totPar = s.pars.reduce((a, b) => a + b, 0);
  const totScore = s.scores.reduce((a, b) => a + (b || 0), 0);
  const tTxt = t === 0 ? 'E' : t > 0 ? `+${t}` : `${t}`;
  let nines = '';
  if (s.pars.length === 18) {
    const o = nineRel(s, 0, 9), i = nineRel(s, 9, 18);
    nines = '<div class="sum-nines">'
      + `<div class="sum-tile"><span>Out</span><b>${o.sc || '–'} <em>${relTxt(o.rel)}</em></b></div>`
      + `<div class="sum-tile"><span>In</span><b>${i.sc || '–'} <em>${relTxt(i.rel)}</em></b></div>`
      + '</div>';
  }
  el.innerHTML = '<div class="sum-eyebrow">⛳ Round complete</div>'
    + '<div class="sum-hero">'
    + `<div class="sum-topar ${t < 0 ? 'under' : t > 0 ? 'over' : ''}">${tTxt}</div>`
    + `<div class="sum-meta"><b>${verdict(t)}</b><span>${totScore} strokes · par ${totPar}</span></div>`
    + `</div>${nines}${highlights(s)}`;
}

// ---------- range & games ----------
const postPractice = (body) => fetch('/api/practice', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).then((r) => { if (!r.ok) showToast('Range & games', r.error || 'not available'); });

function practiceToast(shot) {
  const p = shot.practice;
  let main = !p.shot.holed ? p.shot.note : p.mode === 'closest' ? '⛳ HOLE IN ONE!' : `⛳ ${p.shot.note}!`;
  // a putt's carry says nothing: the putts made so far instead
  let sub = p.mode === 'putting' ? `${p.score.label} ${p.score.value}`
    : `Carry ${shot.sim.carryYd.toFixed(0)} · Total ${shot.sim.totalYd.toFixed(0)} yd`;
  if (p.over && p.score) { sub = main; main = `${p.score.label}: ${p.score.value}`; }
  showToast(main, sub);
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yd0 = (v) => (Number.isFinite(v) ? Math.round(v) : '–');
const lr = (v) => (Number.isFinite(v) ? `${v > 0 ? 'R' : v < 0 ? 'L' : ''}${Math.abs(Math.round(v))}` : '–');
// feet as lib/practice.js words them: '5 in', '2.3 ft', '12 ft'; a chip's to the tenth
// it is scored on, under 20 ft ('10.4 ft')
const ft1 = (v) => (!Number.isFinite(v) ? '–' : v < 1 ? `${Math.max(1, Math.round(v * 12))} in` : `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ft`);
const chipFt = (v) => (v >= 1 && v < 20 ? `${v} ft` : ft1(v));

// Shot columns per game: [heading, cell(shot)].
const PB_COLUMNS = {
  range: [['#', (s) => s.n], ['CLUB', (s) => esc(s.club ? prettyClub(s.club) : '–')], ['CARRY', (s) => yd0(s.carryYd)], ['TOTAL', (s) => yd0(s.totalYd)], ['OFF', (s) => lr(s.offlineYd)]],
  closest: [['#', (s) => s.n], ['CLUB', (s) => esc(s.club ? prettyClub(s.club) : '–')], ['CARRY', (s) => yd0(s.carryYd)],
    ['TO PIN', (s) => (s.holed ? 'ACE' : s.counted === false ? (s.lie === 'water' ? 'water' : 'OB') : `${Math.round(s.toTargetYd * 3)} ft`)]],
  longdrive: [['#', (s) => s.n], ['DIST', (s) => yd0(s.distanceYd)], ['CARRY', (s) => yd0(s.carryYd)], ['OFF', (s) => lr(s.offlineYd)], ['', (s) => (s.counted ? '✓' : '✗')]],
  targets: [['#', (s) => s.n], ['FLAG', (s) => `${s.targetYd}y`], ['TO FLAG', (s) => `${yd0(s.toTargetYd)}y`], ['PTS', (s) => s.points ?? 0]],
  putting: [['#', (s) => s.n], ['PUTT', (s) => ft1(s.puttFt)], ['LEFT', (s) => (s.holed ? 'holed' : ft1(s.leftFt))]],
  chipping: [['#', (s) => s.n], ['CLUB', (s) => esc(s.club ? prettyClub(s.club) : '–')], ['FROM', (s) => `${yd0(s.chipYd)}y`],
    ['TO CUP', (s) => (s.holed ? 'holed' : s.counted === false ? (s.lie === 'water' ? 'water' : 'OB') : chipFt(s.leftFt))], ['PTS', (s) => s.points ?? 0]],
  ladder: [['#', (s) => s.n], ['FLAG', (s) => `${s.targetYd}y`], ['TO FLAG', (s) => `${s.toTargetYd < 10 ? s.toTargetYd : yd0(s.toTargetYd)}y`],
    ['', (s) => (s.climbed ? '✓' : '✗')]],
};

// Where a game stands when its next ball changes (the green games' spot, the ladder's
// rung): the second half of the board's subtitle.
const PB_PROGRESS = {
  putting: (pr, s) => (pr.over ? `game over, ${ft1(pr.score.feetLeft)} left in all`
    : `putt ${pr.ballsHit + 1} of ${pr.ballsTotal} · ${Math.round(s.distToPinYd * 3)} ft`),
  chipping: (pr, s) => (pr.over ? 'game over' : `chip ${pr.ballsHit + 1} of ${pr.ballsTotal} · ${Math.round(s.distToPinYd)} yd`),
  ladder: (pr) => (pr.score.cleared === pr.flags.length ? `all ${pr.flags.length} rungs in ${pr.ballsHit} balls`
    : pr.over ? 'game over' : `rung ${pr.score.cleared + 1} of ${pr.flags.length} · ${pr.target.yd} yd`),
};

function renderPracticeBoard(s) {
  const pr = s.practice;
  $('practice-board').classList.toggle('hidden', !pr);
  document.querySelectorAll('#games-menu .game-card').forEach((c) => c.classList.toggle('active', !!pr && c.dataset.mode === pr.mode));
  if (!pr) return;
  $('pb-mode').textContent = pr.label.toUpperCase();
  const where = pr.mode === 'closest' && pr.holeRef != null ? `Hole ${pr.holeRef}, ${pr.target.yd} yd`
    : greenGame(pr) ? `Hole ${pr.holeRef} green`
      : pr.ground === 'range' ? "On the course's driving range" : "From hole 1's tee (no range mapped)";
  const left = PB_PROGRESS[pr.mode] ? PB_PROGRESS[pr.mode](pr, s)
    : pr.ballsTotal ? (pr.over ? 'game over' : `ball ${pr.ballsHit + 1} of ${pr.ballsTotal}`) : `${pr.ballsHit} balls`;
  $('pb-sub').textContent = `${where} · ${left}`;
  $('pb-score-label').textContent = pr.score ? pr.score.label.toUpperCase() : 'BALLS';
  $('pb-score').textContent = pr.score ? pr.score.value : `${pr.ballsHit}`;

  // flag picker (range, long drive) or par-3 picker (closest to the pin)
  const chips = $('pb-targets');
  chips.innerHTML = '';
  const chip = (label, active, onclick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `chip${active ? ' active' : ''}`; b.textContent = label; b.onclick = onclick;
    chips.appendChild(b);
  };
  if (pr.mode === 'range' || pr.mode === 'longdrive') {
    for (const f of pr.flags) chip(`${f.yd}y`, f.yd === pr.target.yd, () => postPractice({ action: 'target', targetYd: f.yd }));
  } else if (pr.mode === 'closest' && pr.par3s && pr.par3s.length > 1) {
    for (const h of pr.par3s) {
      chip(`#${h.ref} · ${h.lengthYd}y`, h.ref === pr.holeRef, () => postPractice({ mode: 'closest', hole: h.index }));
    }
  }

  const cols = PB_COLUMNS[pr.mode];
  const best = pr.score && pr.score.shot;
  const rows = pr.shots.slice(-8).reverse().map((sh) => {
    const cls = sh.n === best || sh.holed || sh.climbed ? 'best' : sh.counted === false ? 'miss' : '';
    return `<tr class="${cls}">${cols.map(([, cell]) => `<td>${cell(sh)}</td>`).join('')}</tr>`;
  });
  $('pb-shots').innerHTML = rows.length
    ? `<tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}`
    : '<tr><td class="muted">Hit a ball: launch monitor or the Practice shot panel.</td></tr>';

  const clubs = pr.clubStats || [];
  $('pb-clubs').innerHTML = clubs.length
    ? '<div class="panel-eyebrow">CLUB AVERAGES</div><table class="pb-table"><tr><th>CLUB</th><th>BALLS</th><th>CARRY</th><th>TOTAL</th><th>±OFF</th></tr>'
      + clubs.map((c) => `<tr><td>${esc(c.club === '—' ? '–' : prettyClub(c.club))}</td><td>${c.n}</td><td>${yd0(c.carryYd)}</td><td>${yd0(c.totalYd)}</td><td>${yd0(c.offlineYd)}</td></tr>`).join('')
      + '</table>'
    : '';
  $('pb-again').textContent = pr.mode === 'range' ? 'New bucket' : 'Play again';
}

$('btn-games').onclick = () => {
  if (!state?.loaded) { openCourseModal(); return; }
  $('games-menu').classList.toggle('hidden');
  $('btn-games').classList.toggle('active', !$('games-menu').classList.contains('hidden'));
};
document.querySelectorAll('#games-menu .game-card').forEach((card) => {
  card.onclick = () => { $('games-menu').classList.add('hidden'); postPractice({ mode: card.dataset.mode }); };
});
$('pb-again').onclick = () => {
  const pr = state?.practice;
  if (!pr) return;
  // the same par 3, or the same green
  const hole = pr.mode === 'closest' ? (pr.par3s || []).find((h) => h.ref === pr.holeRef)?.index : pr.holeIndex;
  postPractice({ mode: pr.mode, ...(hole != null ? { hole } : {}), ...(pr.mode !== 'targets' ? { targetYd: pr.target.yd } : {}) });
};
$('pb-end').onclick = () => postPractice({ action: 'end' });

// ---------- controls ----------
let fwdBusy = false; // debounce the forward POST so a double-press can't skip a hole (F6)
$('btn-next').onclick = async () => {
  if (fwdBusy) return;
  fwdBusy = true;
  try { await fetch('/api/next-hole', { method: 'POST' }); }
  finally { setTimeout(() => { fwdBusy = false; }, 250); }
};
function toggleScorecard() {
  reviewHole = null;
  $('scorecard').classList.toggle('hidden');
  $('btn-score').classList.toggle('active', !$('scorecard').classList.contains('hidden'));
  if (state) buildScorecard(state);
}
$('btn-score').onclick = toggleScorecard;
$('stat-hole').onclick = toggleScorecard;   // the HOLE badge opens the scorecard (phone hole-nav)
$('stat-hole').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleScorecard(); } };
$('btn-restart').onclick = () => { reviewHole = null; fetch('/api/reset', { method: 'POST' }); $('scorecard').classList.add('hidden'); };
$('btn-changecourse').onclick = () => { $('scorecard').classList.add('hidden'); openCourseModal(); };
$('btn-practice').onclick = () => $('practice').classList.toggle('hidden');
$('btn-course').onclick = () => { closeMenu(); openCourseModal(); };

// menu (top right) and the panels' close buttons
function closeMenu() { $('main-menu').classList.add('hidden'); $('btn-menu').setAttribute('aria-expanded', 'false'); }
$('btn-menu').onclick = (e) => {
  e.stopPropagation();
  const open = $('main-menu').classList.contains('hidden');
  $('main-menu').classList.toggle('hidden', !open);
  $('btn-menu').setAttribute('aria-expanded', open ? 'true' : 'false');
};
document.addEventListener('pointerdown', (e) => {
  if (!$('main-menu').contains(e.target) && !$('btn-menu').contains(e.target)) closeMenu();
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => {
    $(b.dataset.close).classList.add('hidden');
    if (b.dataset.close === 'scorecard') $('btn-score').classList.remove('active');
    if (b.dataset.close === 'games-menu') $('btn-games').classList.remove('active');
  };
});
$('btn-conditions-menu').onclick = () => { closeMenu(); conditions.toggle(true); };
$('btn-bag-reset').onclick = async () => {
  closeMenu();
  if (!window.confirm('Forget every shot this player has hit with each club? Predictions go back to typical numbers until you hit a few again.')) return;
  try { await fetch('/api/bag/reset', { method: 'POST' }); } catch { /* offline */ }
  lineup.refreshCarries(false);
  showToast('Club averages cleared', 'Predictions use typical numbers until you hit a few');
};

// Free course-creator camera: fly/orbit the hole to inspect surfaces against the aerial.
scene.setFreeCamCallback((on) => {
  $('btn-free').classList.toggle('active', on);
  $('btn-free-label').textContent = on ? 'Exit free look' : 'Free look camera';
  $('freecam-hint').classList.toggle('hidden', !on);
});
$('btn-free').onclick = () => { closeMenu(); scene.enterFreeCam(scene.camMode !== 'free'); };

// Hole flyover (render/flyover.js): the Flyover button or F; any key or click skips it.
$('btn-flyover').onclick = () => { if (!animating) scene.flyover.start(); };
// keys: F flyover, W conditions, arrows aim (shift: 2°), A auto-aim, 0 straight, Esc closes
window.addEventListener('keydown', (e) => {
  if (e.repeat && !/^Arrow/.test(e.key)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range') return;
  if ($('course-modal').style.display !== 'none') return;
  const k = String(e.key || '');
  if (k === 'Escape') {
    closeMenu();
    for (const id of ['conditions', 'practice', 'games-menu', 'scorecard']) $(id).classList.add('hidden');
    $('btn-score').classList.remove('active');
    return;
  }
  if (k.toLowerCase() === 'f') { if (!animating && scene.flyover.start()) e.preventDefault(); return; }
  if (k.toLowerCase() === 'w') { conditions.toggle(); return; }
  if (animating) return;
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    lineup.setAim(lineup.aim + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 2 : 0.5));
  } else if (k.toLowerCase() === 'a') {
    if (!lineup.autoAim()) showToast('Auto-aim', 'Needs a prediction for this club');
  } else if (k === '0') lineup.setAim(0);
});

$('aim-slider').oninput = (e) => lineup.setAim(+e.target.value);
$('aim-left').onclick = () => lineup.setAim(lineup.aim - 0.5);
$('aim-right').onclick = () => lineup.setAim(lineup.aim + 0.5);
$('aim-reset').onclick = () => lineup.setAim(0);
$('aim-auto').onclick = () => { if (!lineup.autoAim()) showToast('Auto-aim', 'Needs a prediction for this club'); };
fetch('/api/clubs').then((r) => r.json()).then((p) => { clubPresets = p; });

// practice panel
const PS = ['speed', 'vla', 'hla', 'spin', 'axis'];
const psUnits = { speed: ' mph', vla: '°', hla: '°', spin: ' rpm', axis: '°' };
for (const k of PS) {
  $(`ps-${k}`).oninput = (e) => { $(`ps-${k}-v`).textContent = e.target.value + psUnits[k]; };
}
function setPractice(speed, vla, spin) {
  $('ps-speed').value = speed; $('ps-speed-v').textContent = `${speed} mph`;
  $('ps-vla').value = vla; $('ps-vla-v').textContent = `${vla}°`;
  $('ps-spin').value = spin; $('ps-spin-v').textContent = `${spin} rpm`;
}
$('ps-hit').onclick = () => {
  if (animating || (state?.over && !state?.practice)) return;
  fetch('/api/test-shot', {
    method: 'POST',
    body: JSON.stringify({
      speed: +$('ps-speed').value, vla: +$('ps-vla').value, hla: +$('ps-hla').value,
      spin: +$('ps-spin').value, spinAxis: +$('ps-axis').value,
    }),
  });
};

// ---------- course modal ----------
function openCourseModal() {
  $('course-modal').classList.remove('hidden');
  $('course-modal').style.display = 'flex';
  loadCachedList();
}
function closeCourseModal() {
  $('course-modal').style.display = 'none';
}

async function loadCachedList() {
  try {
    const cached = await (await fetch('/api/courses/cached')).json();
    const el = $('course-cached');
    el.innerHTML = cached.length ? '<p class="muted" style="margin:10px 0 6px">Downloaded courses (instant):</p>' : '';
    for (const c of cached) {
      const d = document.createElement('div');
      d.className = 'result';
      d.innerHTML = `<span class="badge">saved</span> ${c.name.split(',').slice(0, 3).join(',')}`;
      d.onclick = () => pickCourse({ cached: c.file, name: c.name });
      el.appendChild(d);
    }
  } catch (_) { /* server starting */ }
}

async function doSearch(q) {
  if (!q.trim()) return;
  const msg = $('course-msg');
  msg.className = 'muted';
  msg.innerHTML = '<span class="loading-spin"></span>searching OpenStreetMap…';
  $('course-results').innerHTML = '';
  try {
    const rows = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (rows.error) throw new Error(rows.error);
    msg.textContent = rows.length ? '' : 'No golf course found — try the course name plus its town.';
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'result';
      const isCourse = r.type === 'golf_course';
      d.innerHTML = `<span class="badge ${isCourse ? '' : 'other'}">${isCourse ? 'golf course' : r.type}</span> ${r.name}`;
      d.onclick = () => pickCourse({ name: r.name, bbox: r.bbox, osmType: r.osmType, osmId: r.osmId });
      $('course-results').appendChild(d);
    }
  } catch (err) {
    msg.className = 'muted error';
    msg.textContent = 'Search failed: ' + err.message;
  }
}

async function pickCourse(body) {
  const msg = $('course-msg');
  msg.className = 'muted';
  msg.innerHTML = '<span class="loading-spin"></span>Downloading course + terrain from open data… 10–90 s on first load.';
  pickInFlight = true;
  try {
    const r = await (await fetch('/api/load-course', { method: 'POST', body: JSON.stringify(body) })).json();
    if (r.error) throw new Error([r.error, r.diagnostic && r.diagnostic.recovery].filter(Boolean).join(' '));
    msg.textContent = '';
    // course SSE event closes the modal & loads geometry
  } catch (err) {
    msg.className = 'muted error';
    msg.textContent = err.message;
  } finally {
    pickInFlight = false;
  }
}

$('course-search').onclick = () => doSearch($('course-q').value);
$('course-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch($('course-q').value); });
document.querySelectorAll('.modal-box .chip').forEach((c) => {
  c.onclick = () => { $('course-q').value = c.dataset.q; doSearch(c.dataset.q); };
});

// ---------- boot ----------
(async () => {
  try {
    await loadGeometry();
    const s = await (await fetch('/api/state')).json();
    applyState(s);
    if (!s.loaded) openCourseModal();
    else closeCourseModal();
  } catch (err) {
    console.error('boot failed', err);
  }
})();
