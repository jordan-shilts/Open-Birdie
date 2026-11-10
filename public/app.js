// Open-Birdie UI glue: SSE <-> HUD <-> 3D scene.
import { GolfScene } from './render/scene.js';
import { loadHdBundle } from './render/hd-bundle.js';
import { buildHdAckEvidence, validateHdPolicy, waitForCaptureReady } from './render/capture-readiness.js';
import { toPar, forwardLabel, verdict } from './scoring.mjs';
import { FlightView } from './flight-view.js';
import { AimMap } from './aim-map.js';
import { ConditionsUI } from './conditions-ui.js';
import { Lineup, CLUBS, clubByLabel, writeAutoClub } from './lineup.js';
import { LeaguesUI } from './leagues-ui.js';
import { renderClubPanel } from './club-panel.js';
import { parseQualitySetting, qualityLabel } from './render/quality.js';
import { parseSkySetting, SKY_ORDER, SKY_PRESETS } from './render/sky-presets.js';

const $ = (id) => document.getElementById(id);
// Readiness nonce handed only to the loopback Electron primary client (absent on LAN mirrors).
const query = new URLSearchParams(location.search);
const primaryNonce = query.get('primaryNonce') || '';
const visualCaptureEnabled = query.get('visualCapture') === '1';
// Graphics quality: ?gfx=auto|ultra|high|low overrides the saved choice (Auto by default).
// Visual-capture runs pin High and never auto-downshift, so frames stay comparable.
const GFX_KEY = 'open-birdie.graphics';
const readGfx = () => { try { return localStorage.getItem(GFX_KEY); } catch { return null; } };
let gfxSetting = parseQualitySetting(query.get('gfx') || (visualCaptureEnabled ? 'high' : readGfx()) || 'auto');
// Time of day: ?sky=morning|midday|golden overrides the saved choice (Midday by default;
// visual capture pins Midday unless asked).
const SKY_KEY = 'open-birdie.sky';
const readSky = () => { try { return localStorage.getItem(SKY_KEY); } catch { return null; } };
let skySetting = parseSkySetting(query.get('sky') || (visualCaptureEnabled ? 'midday' : readSky()));
// The shot camera: 'follow' flies with the ball (the default), 'tv' covers it from the
// tee and the landing area (render/flight-camera.js); ?shotcam= overrides the saved one.
const SHOTCAM_KEY = 'open-birdie.shotcam';
const readShotCam = () => { try { return localStorage.getItem(SHOTCAM_KEY); } catch { return null; } };
let shotCam = (query.get('shotcam') || readShotCam()) === 'tv' ? 'tv' : 'follow';
const scene = new GolfScene($('scene'), { quality: gfxSetting, autoQuality: !visualCaptureEnabled, sky: skySetting, shotCam });
const flightView = new FlightView($('flightview'));
const leaguesUI = new LeaguesUI({
  toast: (main, sub) => showToast(main, sub),
  clearStage: () => {
    for (const id of ['scorecard', 'games-menu']) $(id).classList.add('hidden');
    $('btn-score').classList.remove('active');
    $('btn-games').classList.remove('active');
  },
});

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
segmented($('seg-gfx'), [['auto', 'Auto'], ['ultra', 'Ultra'], ['high', 'High'], ['low', 'Low']], gfxSetting, (v) => {
  gfxSetting = parseQualitySetting(v);
  try { localStorage.setItem(GFX_KEY, gfxSetting); } catch { /* private mode */ }
  scene.setQuality(gfxSetting);
  showGfx(scene.quality);
});
scene.onQualityChange = showGfx;
showGfx(scene.quality);
segmented($('seg-shotcam'), [['follow', 'Follow the ball'], ['tv', 'TV']], shotCam, (v) => {
  shotCam = v === 'tv' ? 'tv' : 'follow';
  try { localStorage.setItem(SHOTCAM_KEY, shotCam); } catch { /* private mode */ }
  scene.setShotCam(shotCam);
  markSeg($('seg-shotcam'), shotCam);
});
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
  onPlan: (pt) => lineup.setLayup(pt),
});
const lineup = new Lineup({
  scene, flightView, aimMap, conditions,
  onClubChange: (key) => { const p = clubPresets[key]; if (p) setPractice(p.speedMph, p.vla, p.spin); },
});
window.__birdie = { scene, lineup, get state() { return state; } };
// the gimme (lib/settings.js): the server keeps it; the state shows what it is
segmented($('seg-gimme'), [['0', 'Off'], ['2', '2 ft'], ['3', '3 ft'], ['5', '5 ft'], ['8', '8 ft'], ['10', '10 ft']], '', (v) => {
  markSeg($('seg-gimme'), v);
  fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gimmeFt: +v }) }).catch(() => {});
});
segmented($('seg-autoclub'), [['on', 'On'], ['off', 'Off']], lineup.autoClub ? 'on' : 'off', (v) => {
  lineup.autoClub = v === 'on';
  writeAutoClub(lineup.autoClub);
  markSeg($('seg-autoclub'), v);
});
segmented($('seg-details'), [['off', 'Off'], ['on', 'On']], lineup.details ? 'on' : 'off', (v) => {
  lineup.setDetails(v === 'on');
  markSeg($('seg-details'), v);
});
// the club delivery card beside the last shot (club-panel.js): on unless turned off
const CLUBCARD_KEY = 'open-birdie.clubcard';
let clubCardOn = (() => { try { return localStorage.getItem(CLUBCARD_KEY) !== 'off'; } catch { return true; } })();
let clubCardShot = null;   // the shot whose club data the card shows
segmented($('seg-clubcard'), [['on', 'On'], ['off', 'Off']], clubCardOn ? 'on' : 'off', (v) => {
  clubCardOn = v === 'on';
  try { localStorage.setItem(CLUBCARD_KEY, v); } catch { /* private window */ }
  markSeg($('seg-clubcard'), v);
  showClubCard(clubCardShot);
});
function showClubCard(shot) {
  clubCardShot = shot;
  const el = $('clubpanel');
  const d = clubCardOn && shot && !$('shotpanel').classList.contains('hidden') && !$('shotpanel').classList.contains('no-room') ? shot.clubData : null;
  const label = $('sp-club').textContent;
  renderClubPanel(el, d || null, { clubName: label });
  el.style.top = $('shotpanel').style.top;
}

let state = null;
let pendingState = null;
let animating = false;
let lastHoleKey = '';
let lastIntroKey = '';  // the hole whose name/note toast was shown (once per hole)
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
  $('player-name').textContent = s.player ? s.player.name : 'Player 1';
  $('player-avatar').textContent = s.player ? s.player.initials : 'P1';
  leaguesUI.setGameState(s);
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
    setStat('hud-len', 'LENGTH', `${s.scorecardYd ?? s.lengthYd}y`); // the play tee's scorecard yardage when researched
    setStat('hud-strokes', 'STROKES', s.strokes);
    const introKey = `${s.courseName}#${s.hole}`;
    if (introKey !== lastIntroKey && !s.over) { lastIntroKey = introKey; showHoleIntro(s); }
  }
  updateForward(s);
  if (!lineup._dragging) {
    lineup.showAim(s.aimOffset);
  }
  updateScoreChip(s);
  markSeg($('seg-gimme'), String(s.settings?.gimmeFt ?? ''));

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
  updateMulligan();
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
es.addEventListener('course', () => { loadGeometry(); closeCourseModal(); loadLibrary(); });
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
es.addEventListener('leagues', (e) => leaguesUI.setData(JSON.parse(e.data)));
es.addEventListener('league-card', (e) => leaguesUI.cardPosted(JSON.parse(e.data)));
es.addEventListener('lm', (e) => {
  const lm = JSON.parse(e.data);
  $('lm-status').classList.toggle('connected', lm.connected);
  $('lm-text').textContent = lm.connected ? 'Monitor connected' : 'Monitor offline';
});
let lineupBack = null;   // after a shot lands: back to lining up the next one
let lastShot = null;     // { shot, plan, savedId, mulled }: the round's latest shot (Save, mulligan)
let replay = null;       // a saved shot replaying (the round is not touched), or null
es.addEventListener('shot', (e) => {
  const shot = JSON.parse(e.data);
  if (replay) endReplay();    // a live ball mid-replay: back to the round's hole first
  const plan = lineup.pred;   // what this club was predicted to do, for the comparison
  lastShot = { shot, plan, savedId: null, mulled: false };
  showShotData(shot, plan);
  setSaveButton();
  animating = true;
  updateMulligan();
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
    updateMulligan();
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
    spinRpm: shot.launch?.totalSpin, spinAxisDeg: shot.launch?.spinAxis,
    events: shot.sim.events,   // bounces, water, trees: what the landing throws up (render/impact-fx.js)
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
// view: 'live' (a shot just hit: the dock follows its club), 'restore' (the round's last
// shot shown again, e.g. after a replay) or 'replay' (a saved shot replaying)
function showShotData(shot, plan = null, view = 'live') {
  $('shotpanel').classList.remove('hidden');
  const mulled = view === 'restore' && !!lastShot?.mulled;
  $('shotpanel').classList.toggle('replaying', view === 'replay');
  $('shotpanel').classList.toggle('mulled', mulled);
  $('sp-label').textContent = view === 'replay' ? 'SAVED SHOT' : mulled ? 'MULLIGAN' : 'LAST SHOT';
  const l = shot.launch, sim = shot.sim;
  // the club the server put the shot down to (the monitor's, else the one in hand, as the
  // bag records it); a guess from ball speed only when neither is known. The guess alone
  // read the game's own typical driver (152 mph) as a 3 wood, and moved the club dock to it.
  const keyed = shot.clubKey ? CLUBS.find((c) => c.key === shot.clubKey)?.label : null;
  const club = shot.club ? prettyClub(shot.club) : (keyed || clubFromShot(l.speedMph, sim.isPutt));
  if (view === 'live' && (shot.club || keyed)) lineup.markClubLabel(club);   // never move the dock to a guess
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
  showClubCard(shot);
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

function showToast(main, sub = '', ms = 4200) {
  const t = $('toast');
  t.innerHTML = `${esc(main)}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
  t.classList.remove('hidden');
  t.style.opacity = 1;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = 0; }, ms);
}

// A hole with a researched name or note introduces itself as it starts.
function showHoleIntro(s) {
  const note = s.holeNote || s.greenNote;
  if (!s.holeName && !note) return;
  const title = `Hole ${s.holeRef ?? s.hole}${s.holeName ? ` · ${s.holeName}` : ''}`;
  const facts = [`Par ${s.par}`, `${s.scorecardYd ?? s.lengthYd} yd${s.playTee ? ` (${s.playTee})` : ''}`,
    s.handicap != null ? `HCP ${s.handicap}` : null].filter(Boolean).join(' · ');
  showToast(esc(title), esc(note ? `${facts} — ${note}` : facts), 7000);
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

// Review a played hole: highlight that hole's column on the scorecard (a click on its
// number there). (E1 — review is the scorecard, not a shot replay or a camera move.)
function reviewHoleOnCard(h) {
  if (!state || state.scores[h - 1] == null) return;
  reviewHole = h - 1;
  $('scorecard').classList.remove('hidden');
  buildScorecard(state);
}

// ---------- scorecard ----------
function buildScorecard(s) {
  const n = s.pars.length;
  // researched scorecards add a row per tee (the play tee first) and the hole handicaps
  const tees = s.tees || [];
  const hcps = (s.handicaps || []).some((x) => x != null) ? s.handicaps : null;
  let h1 = '<tr><th></th>', p1 = '<tr><th>Par</th>', s1 = '<tr><th>Score</th>', hc = '<tr class="hcp"><th>Hcp</th>';
  const teeRows = tees.map((t) => `<tr class="tee${t.name === s.playTee ? ' play' : ''}"><th>${esc(t.name)}</th>`);
  for (let i = 0; i < n; i++) {
    const hl = i === reviewHole ? ' review' : '';
    const name = s.holeNames && s.holeNames[i];
    h1 += `<th class="${hl.trim()}" data-h="${i + 1}"${name ? ` title="${esc(name)}"` : ''}>${(s.holeRefs && s.holeRefs[i]) ?? i + 1}</th>`;
    tees.forEach((t, k) => { teeRows[k] += `<td class="${hl.trim()}">${t.yards[i] ?? ''}</td>`; });
    p1 += `<td class="${hl.trim()}">${s.pars[i]}</td>`;
    if (hcps) hc += `<td class="${hl.trim()}">${hcps[i] ?? ''}</td>`;
    const sc = s.scores[i];
    const cls = sc == null ? '' : sc < s.pars[i] ? 'under' : sc > s.pars[i] ? 'over' : '';
    const dot = (s.pickedUp && s.pickedUp[i]) ? '<i class="pu" title="picked up"></i>' : '';
    s1 += `<td class="${(cls + hl).trim()}">${sc ?? ''}${dot}</td>`;
  }
  const totPar = s.pars.reduce((a, b) => a + b, 0);
  const totScore = s.scores.reduce((a, b) => a + (b || 0), 0);
  const teeHtml = tees.map((t, k) => `${teeRows[k]}<td>${t.yards.reduce((a, b) => a + (b || 0), 0) || ''}</td></tr>`).join('');
  // mulligans, per hole, only once any have been taken: the card stays honest
  const mull = s.mulligans || [];
  const totMull = mull.reduce((a, b) => a + (b || 0), 0);
  let m1 = '';
  if (totMull) {
    m1 = '<tr class="mull"><th title="Mulligans taken">Mull.</th>';
    for (let i = 0; i < n; i++) m1 += `<td class="${i === reviewHole ? 'review' : ''}">${mull[i] || ''}</td>`;
    m1 += `<td>${totMull}</td></tr>`;
  }
  $('score-table').innerHTML =
    `<table>${h1}<th>Σ</th></tr>${teeHtml}${p1}<td>${totPar}</td></tr>${hcps ? `${hc}<td></td></tr>` : ''}` +
    `${s1}<td>${totScore || ''}</td></tr>${m1}</table>`;
  $('scorecard').classList.toggle('with-tees', tees.length > 0);
  buildSummary(s);
}
$('score-table').onclick = (e) => {
  const th = e.target.closest('th[data-h]');
  if (th) reviewHoleOnCard(+th.dataset.h);
};

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
  const mull = (s.mulligans || []).reduce((a, b) => a + (b || 0), 0);
  if (mull) chips.push(`<span class="sum-chip">${mull} mulligan${mull > 1 ? 's' : ''}</span>`);
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
  const open = $('games-menu').classList.contains('hidden');
  if (open) {   // one screen mid-stage at a time
    leaguesUI.toggle(false);
    $('scorecard').classList.add('hidden');
    $('btn-score').classList.remove('active');
  }
  $('games-menu').classList.toggle('hidden', !open);
  $('btn-games').classList.toggle('active', open);
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
  if ($('scorecard').classList.contains('hidden')) {   // one panel mid-screen at a time
    leaguesUI.toggle(false);
    $('games-menu').classList.add('hidden');
    $('btn-games').classList.remove('active');
  }
  $('scorecard').classList.toggle('hidden');
  $('btn-score').classList.toggle('active', !$('scorecard').classList.contains('hidden'));
  if (state) buildScorecard(state);
}
$('btn-score').onclick = toggleScorecard;
$('btn-score-tile').onclick = toggleScorecard;
$('btn-league').onclick = () => leaguesUI.toggle();
$('stat-hole').onclick = toggleScorecard;   // the HOLE badge opens the scorecard (phone hole-nav)
$('stat-hole').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleScorecard(); } };
$('btn-restart').onclick = () => { reviewHole = null; fetch('/api/reset', { method: 'POST' }); $('scorecard').classList.add('hidden'); };
$('btn-changecourse').onclick = () => { $('scorecard').classList.add('hidden'); openCourseModal(); };
$('btn-practice').onclick = () => $('practice').classList.toggle('hidden');
$('btn-course').onclick = () => { closeMenu(); openCourseModal(); };

// the menu (top right): a settings drawer from the right edge; the panels' close buttons
function setMenu(open) {
  $('main-menu').classList.toggle('open', open);
  $('main-menu').setAttribute('aria-hidden', open ? 'false' : 'true');
  $('menu-scrim').classList.toggle('open', open);
  $('btn-menu').setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeMenu() { setMenu(false); }
$('btn-menu').onclick = (e) => {
  e.stopPropagation();
  setMenu(!$('main-menu').classList.contains('open'));
};
$('menu-close').onclick = closeMenu;
// a tile in the menu opens its screen in place of the menu
document.querySelectorAll('#main-menu .hub-tile').forEach((t) => t.addEventListener('click', closeMenu));

// ---------- one panel at a time ----------
// The mid-screen panels and the buttons that open them. An observer watches the panels'
// class lists, so however one opens (its button, a menu tile, a key, the league flow)
// the one opened last stays and the others close, every button shows what is open, and
// body.stage-open puts the dimmed backdrop behind it and steps the play HUD aside
// (style.css). A click on the backdrop closes it.
// [panel, its buttons, dims the stage]: the practice-shot panel stays open while its
// shots fly, so it keeps the course and the HUD in view
const STAGE = [
  ['scorecard', ['btn-score', 'btn-score-tile'], true],
  ['saved-panel', ['btn-saved'], true],
  ['games-menu', ['btn-games'], true],
  ['league-panel', ['btn-league'], true],
  ['conditions', ['cond-widget'], true],
  ['practice', ['btn-practice'], false],
];
const stageOpen = (id) => !$(id).classList.contains('hidden');
function syncStage() {
  let dim = false;
  for (const [id, btns, dims] of STAGE) {
    const open = stageOpen(id);
    dim = dim || (open && dims);
    for (const b of btns) $(b)?.classList.toggle('active', open);
  }
  document.body.classList.toggle('stage-open', dim);
}
function closeStage() {
  for (const [id] of STAGE) $(id).classList.add('hidden');
  reviewHole = null;
}
const stageObserver = new MutationObserver((records) => {
  const opened = records.filter((r) => /\bhidden\b/.test(r.oldValue || '') && stageOpen(r.target.id)).map((r) => r.target.id);
  const keep = opened[opened.length - 1];
  if (keep) for (const [id] of STAGE) if (id !== keep && stageOpen(id)) $(id).classList.add('hidden');
  syncStage();
});
for (const [id] of STAGE) stageObserver.observe($(id), { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
$('stage-scrim').onclick = closeStage;
syncStage();
document.addEventListener('pointerdown', (e) => {
  if (!$('main-menu').contains(e.target) && !$('btn-menu').contains(e.target)) closeMenu();
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => {
    $(b.dataset.close).classList.add('hidden');
    if (b.dataset.close === 'scorecard') $('btn-score').classList.remove('active');
    if (b.dataset.close === 'league-panel') $('btn-league').classList.remove('active');
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

// ---------- mulligans ----------
// After a round shot lands, Mulligan (or M) takes it back: the server restores the ball,
// strokes and score and counts the mulligan on the card (lib/game.js mulligan).
function updateMulligan() {
  const can = !!(state && state.loaded && state.canMulligan && !state.practice && !animating && !replay);
  $('btn-mulligan').classList.toggle('hidden', !can);
}
async function takeMulligan() {
  if (animating || replay || !state?.canMulligan) return;
  const b = $('btn-mulligan');
  b.disabled = true;
  try {
    const r = await fetch('/api/mulligan', { method: 'POST' }).then((x) => x.json());
    if (!r.ok) showToast('Mulligan', r.error || 'Nothing to take back');
  } catch { showToast('Mulligan', 'The game is not answering'); }
  finally { b.disabled = false; }
}
$('btn-mulligan').onclick = takeMulligan;
es.addEventListener('mulligan', (e) => {
  const m = JSON.parse(e.data);
  clearTimeout(lineupBack);
  scene.clearShot();
  aimMap.setShot([]);
  flightView.lineup();
  if (lastShot) lastShot.mulled = true;
  $('shotpanel').classList.add('mulled');
  $('sp-label').textContent = 'MULLIGAN';
  lastHoleKey = '';   // the state that follows puts the ball back: re-frame it there at once
  showToast('↺ Mulligan, hit it again', m.mulligans > 1 ? `${m.mulligans} mulligans on this hole` : 'The scorecard counts it');
});

// ---------- saved shots ----------
// ★ on the last-shot panel (or in the Saved panel) keeps a shot with its flight; the
// Saved panel lists them and replays one on the course it was hit on. A replay only
// moves the camera and the ball on screen: the round is never touched.
const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
let serverLastShotId = null;   // the server's last shot, when this screen missed its event

function setSavedCount(n) {
  const c = $('saved-count');
  c.textContent = n > 99 ? '99+' : `${n}`;
  c.classList.toggle('hidden', !n);
}
function setSaveButton() {
  const b = $('sp-save');
  const saved = !!lastShot?.savedId;
  b.setAttribute('aria-pressed', saved ? 'true' : 'false');
  b.querySelector('span').textContent = saved ? 'Saved' : 'Save';
  b.title = saved ? 'Saved; press again to remove it from your saved shots' : 'Save this shot to your saved shots';
  b.disabled = !lastShot || !!replay;
  const add = $('saved-add');
  add.disabled = saved || replay || !(lastShot || serverLastShotId != null);
  add.textContent = saved ? '★ Last shot saved' : '★ Save the last shot';
}
async function saveLastShot() {
  const shotId = lastShot ? lastShot.shot.shotId : serverLastShotId;
  if (shotId == null) return;
  try {
    const r = await postJson('/api/saved-shots', { shotId });
    if (!r.ok) { showToast('Save shot', r.error || 'Could not save it'); return; }
    if (lastShot && lastShot.shot.shotId === shotId) lastShot.savedId = r.shot.id;
    setSaveButton();
    showToast('★ Shot saved', 'Replay it any time from Saved');
  } catch { showToast('Save shot', 'The game is not answering'); }
}
async function removeSaved(id) {
  try { await postJson('/api/saved-shots/remove', { id }); } catch { showToast('Saved shots', 'The game is not answering'); }
}
$('sp-save').onclick = () => (lastShot?.savedId ? removeSaved(lastShot.savedId) : saveLastShot());
$('saved-add').onclick = saveLastShot;
es.addEventListener('saved-shots', (e) => {
  const ev = JSON.parse(e.data);
  setSavedCount(ev.count);
  if (ev.saved && lastShot && ev.shotId === lastShot.shot.shotId) lastShot.savedId = ev.saved;
  if (ev.removed && lastShot && lastShot.savedId === ev.removed) lastShot.savedId = null;
  setSaveButton();
  if (!$('saved-panel').classList.contains('hidden')) renderSaved();
});

const courseShort = (name) => String(name || '').split(',')[0];
const PRACTICE_NAMES = { range: 'Driving range', closest: 'Closest to the pin', longdrive: 'Long drive', targets: 'Target challenge' };
// the club a saved shot was hit with: the monitor's or the player's pick, else the one
// its ball speed suggests (as the last-shot panel shows it)
function savedClubName(s) {
  const label = s.club ? prettyClub(s.club) : clubFromShot(s.launch.speedMph, s.result.isPutt);
  return clubByLabel(label)?.name || label;
}
function savedRowHtml(s, here) {
  const club = savedClubName(s);
  const r = s.result, l = s.launch;
  const main = r.isPutt
    ? `<b>${Math.round(r.totalYd * 3)}<small>ft</small></b> putt`
    : `<b>${Math.round(r.carryYd)}<small>yd</small></b> carry · <b>${Math.round(r.totalYd)}<small>yd</small></b>`;
  const when = new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const where = [when, s.practice ? PRACTICE_NAMES[s.practice] || 'Practice' : `Hole ${s.holeRef ?? s.hole ?? '?'}`, courseShort(s.course)].join(' · ');
  const launch = `${l.speedMph.toFixed(1)} mph · ${l.vla.toFixed(1)}° · ${Math.round(l.totalSpin)} rpm${r.isPutt ? '' : ` · apex ${Math.round(r.apexFt)} ft`}`;
  const tip = here ? 'Replay the flight' : `Load ${courseShort(s.course)} to replay it`;
  return `<div class="saved-row" data-id="${esc(s.id)}">`
    + `<div class="saved-main"><span class="saved-club">${esc(club)}</span>${main}</div>`
    + `<div class="saved-where">${esc(where)}</div>`
    + `<div class="saved-launch">${esc(launch)}</div>`
    + `<div class="saved-acts"><button class="btn" data-act="replay"${here ? '' : ' disabled'} title="${esc(tip)}">▶ Replay</button>`
    + '<button class="btn x" data-act="remove" title="Remove from saved shots" aria-label="Remove from saved shots">✕</button></div>'
    + '</div>';
}
async function renderSaved() {
  let data;
  try { data = await (await fetch('/api/saved-shots')).json(); } catch { data = null; }
  const list = $('saved-list');
  if (!data || !Array.isArray(data.shots)) { list.innerHTML = '<div class="saved-empty">Saved shots are not available right now.</div>'; return; }
  setSavedCount(data.shots.length);
  serverLastShotId = data.lastShotId ?? null;
  if (lastShot && lastShot.shot.shotId === serverLastShotId) {
    lastShot.savedId = data.shots.find((x) => x.shotId === serverLastShotId && x.at >= Date.now() - 6 * 3600e3)?.id ?? lastShot.savedId;
  }
  setSaveButton();
  if (!data.shots.length) {
    list.innerHTML = '<div class="saved-empty">No saved shots yet. Hit one you love, then press ★ Save on the last-shot panel, or the button above.</div>';
    return;
  }
  const course = state?.loaded ? state.courseName : null;
  list.innerHTML = data.shots.map((x) => savedRowHtml(x, x.course === course)).join('');
  list.querySelectorAll('.saved-row').forEach((row) => {
    row.querySelector('[data-act="replay"]').onclick = () => replaySaved(row.dataset.id);
    row.querySelector('[data-act="remove"]').onclick = () => removeSaved(row.dataset.id);
  });
}
function openSaved(open) {
  $('saved-panel').classList.toggle('hidden', !open);
  $('btn-saved').classList.toggle('active', open);
  if (open) renderSaved();
}
$('btn-saved').onclick = () => openSaved($('saved-panel').classList.contains('hidden'));
fetch('/api/saved-shots').then((r) => r.json()).then((d) => {
  if (Array.isArray(d.shots)) setSavedCount(d.shots.length);
  serverLastShotId = d.lastShotId ?? null;
  setSaveButton();
}).catch(() => {});

// Replay a saved shot where it was hit: the scene goes to that spot and aim, flies the
// stored trajectory with the side view, then comes back to the round as it stands.
async function replaySaved(id) {
  if (animating || replay || !scene.geo || !state?.loaded) return;
  let rec = null;
  try { rec = await (await fetch(`/api/saved-shots/${encodeURIComponent(id)}`)).json(); } catch { /* offline */ }
  if (!rec || !Array.isArray(rec.points) || rec.points.length < 2) { showToast('Replay', 'That saved shot could not be loaded'); return; }
  if (rec.course !== state.courseName) { showToast('Replay', `Load ${courseShort(rec.course)} to replay it`); return; }
  if (animating || replay) return;   // a live ball came in while it loaded
  openSaved(false);
  const pts = rec.points.map(([t, x, y, z]) => ({ t, x, y, z }));
  const r = rec.result;
  const shot = {
    launch: rec.launch, club: rec.club, clubData: rec.clubData ?? null, strokes: null, note: r.note, lie: r.lie,
    sim: { points: pts, carryYd: r.carryYd, totalYd: r.totalYd, offlineYd: r.offlineYd, apexFt: r.apexFt, flightTime: r.flightTime, isPutt: r.isPutt, events: Array.isArray(rec.events) ? rec.events : [] },
  };
  const token = { id, doneTimer: null };
  replay = token;
  animating = true;
  clearTimeout(lineupBack);
  lineup.setFlying(true);
  showShotData(shot, null, 'replay');
  setSaveButton();
  updateMulligan();
  const label = savedClubName(rec);
  const where = rec.practice ? PRACTICE_NAMES[rec.practice] || 'Practice' : `Hole ${rec.holeRef ?? rec.hole ?? '?'}`;
  const toast = $('toast');   // the last shot's toast would sit over the banner
  clearTimeout(toast._h);
  toast.style.opacity = 0;
  const banner = $('replay-banner');
  banner.innerHTML = `<span class="lbl">REPLAY</span>${esc([where, label, r.isPutt ? `${Math.round(r.totalYd * 3)} ft putt` : `${Math.round(r.carryYd)} yd carry`].filter(Boolean).join(' · '))}`;
  banner.classList.remove('hidden');
  const rp = rec.replay || {};
  const end = pts[pts.length - 1];
  scene.setHole(
    { pin: rp.pin || [end.x, end.y], tee: rp.tee || null, ref: rec.practice ? null : (rec.holeRef ?? rec.hole ?? null) },
    rp.from || { x: pts[0].x, y: pts[0].y },
    Number.isFinite(rp.aimDeg) ? rp.aimDeg : state.aimDeg,
  );
  await new Promise((res) => setTimeout(res, 700));   // the camera settles behind the ball
  if (replay !== token) return;
  flightView.startShot(shot);
  scene.playShot(pts, r.flightTime, () => {
    if (replay !== token) return;
    flightView.finish();
    token.doneTimer = setTimeout(() => { if (replay === token) endReplay(); }, 1600);
  }, { onProgress: (t) => flightView.setTime(t), isPutt: !!r.isPutt, spinRpm: rec.launch?.totalSpin, spinAxisDeg: rec.launch?.spinAxis, events: rec.events });
}
function endReplay() {
  const r = replay;
  if (!r) return;
  clearTimeout(r.doneTimer);
  replay = null;
  $('replay-banner').classList.add('hidden');
  animating = false;
  lineup.setFlying(false);
  flightView.lineup();
  scene.clearShot();
  // back to the round: its hole and ball (the camera re-frames there) and its last shot
  lastHoleKey = '';
  const s = pendingState || state;
  pendingState = null;
  if (s) applyState(s);
  if (lastShot) showShotData(lastShot.shot, lastShot.plan, 'restore');
  else { $('shotpanel').classList.add('hidden'); showClubCard(null); }
  setSaveButton();
  updateMulligan();
}

// Free course-creator camera: fly/orbit the hole to inspect surfaces against the aerial.
scene.setFreeCamCallback((on) => {
  $('btn-free').classList.toggle('active', on);
  $('btn-free-label').textContent = on ? 'Exit free look' : 'Free look camera';
  $('freecam-hint').classList.toggle('hidden', !on);
});
$('btn-free').onclick = () => { closeMenu(); scene.enterFreeCam(scene.camMode !== 'free'); };

// Performance check (perf-check.mjs): times this computer's frame, and each part of it,
// shows the numbers and keeps a copy on the game computer (data/perf-reports), so the
// sim PC's own GPU says what to make cheaper. A page opened with ?perfcheck runs it once
// the course is in.
let perfRunning = false;
async function perfCheck() {
  if (perfRunning) return;
  closeMenu();
  const msg = $('perf-msg'), out = $('perf-out');
  $('perf-modal').classList.remove('hidden');
  out.innerHTML = '';
  if (!state?.loaded || !scene.geo || animating) {
    msg.textContent = animating ? 'Wait for the ball to stop, then run it again.' : 'Load a course first: the check measures the hole on screen.';
    return;
  }
  perfRunning = true;
  msg.textContent = 'Measuring. The picture flickers while parts are hidden in turn (about half a minute).';
  try {
    const { runPerfCheck, summarizePerf } = await import('./perf-check.mjs');
    const report = await runPerfCheck(scene, {
      state, onProgress: (n, total, label) => { msg.textContent = `Measuring ${n} of ${total}: ${label}`; },
    });
    const fps = (ms) => (ms > 0 ? Math.round(1000 / ms) : 0);
    const full = report.frames[0]?.canvas;
    const row = (a, b) => `<div class="perf-row"><span>${esc(a)}</span><b>${esc(b)}</b></div>`;
    msg.textContent = `${report.gpu || 'Unknown GPU'} · ${qualityLabel(report.level || 'high', report.level || 'high')} graphics · ${String(report.course || '').split(',')[0]}${report.hole != null ? `, hole ${report.hole}` : ''}`;
    out.innerHTML = '<div class="perf-sec">THE WHOLE FRAME</div>'
      + report.frames.map((f) => row(`${f.canvas}${f.scale < 1 ? ' (dynamic resolution\'s floor)' : ''}`, `${f.ms.toFixed(1)} ms · up to ${fps(f.ms)} fps`)).join('')
      + `<div class="perf-sec">WHAT EACH PART COSTS AT ${esc(full || '')}</div>`
      + report.parts.filter((p) => p.canvas === full).sort((a, b) => b.savedMs - a.savedMs)
        .map((p) => row(p.part, `${Math.max(0, p.savedMs).toFixed(1)} ms · ${Math.round(Math.max(0, p.savedMs) / p.ofMs * 100)}%`)).join('')
      + '<div class="perf-note" id="perf-saved">Saving a copy…</div>';
    console.log('[perf]', summarizePerf(report));
    try {
      const r = await fetch('/api/perf-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      const j = await r.json().catch(() => ({}));
      $('perf-saved').textContent = r.ok && j.ok ? `A copy is saved on the game computer (${j.file}).` : `No copy saved (${j.error || `HTTP ${r.status}`}).`;
    } catch {
      $('perf-saved').textContent = 'No copy saved: the game computer did not answer.';
    }
  } catch (e) {
    msg.textContent = `The check stopped: ${e.message}`;
  } finally {
    perfRunning = false;
  }
}
$('btn-perfcheck').onclick = perfCheck;
$('perf-close').onclick = () => { if (!perfRunning) $('perf-modal').classList.add('hidden'); };
if (query.has('perfcheck')) {
  const wait = setInterval(() => {
    if (state?.loaded && state.runtimeReady && scene.geo && !animating) { clearInterval(wait); setTimeout(perfCheck, 4000); }
  }, 500);
}

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
    lineup.openDock(false);
    for (const id of ['conditions', 'practice', 'games-menu', 'scorecard', 'league-panel', 'saved-panel', 'player-menu']) $(id).classList.add('hidden');
    if (!perfRunning) $('perf-modal').classList.add('hidden');
    leaguesUI.closeResult();
    $('btn-score').classList.remove('active');
    $('btn-league').classList.remove('active');
    $('btn-games').classList.remove('active');
    return;
  }
  if (k.toLowerCase() === 'f') { if (!animating && scene.flyover.start()) e.preventDefault(); return; }
  if (k.toLowerCase() === 'w') { conditions.toggle(); return; }
  if (k.toLowerCase() === 'l') { leaguesUI.toggle(); return; }
  if (animating) return;
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    lineup.setAim(lineup.aim + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 2 : 0.5));
  } else if (k.toLowerCase() === 'a') {
    autoAim();
  } else if (k === '0') lineup.setAim(0);
  else if (k.toLowerCase() === 'm' && scene.camMode !== 'free') takeMulligan();
});

$('aim-slider').oninput = (e) => lineup.setAim(+e.target.value);
$('aim-left').onclick = () => lineup.setAim(lineup.aim - 0.5);
$('aim-right').onclick = () => lineup.setAim(lineup.aim + 0.5);
$('aim-reset').onclick = () => lineup.setAim(0);
$('aim-auto').onclick = () => autoAim();
// AUTO: the safe spot, with where it aims said out loud
function autoAim() {
  const where = lineup.autoAim();
  if (!where) showToast('Auto aim', 'Needs a prediction for this club');
  else showToast(`Aiming at ${where}`, 'Allowing for the wind and your shape');
}
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

// ---------- course picker ----------
// Every course at a glance (/api/courses, lib/course-library.js): the downloaded ones,
// last played first, then the featured ones not downloaded yet. Typing filters the cards
// at once; Up / Down pick one and Enter plays it; with nothing matching, Enter searches
// the map (OpenStreetMap) for any course in the world. A click on a card plays it.
let library = null;   // the last /api/courses
let libSel = -1;      // the card picked with the keys (index among the visible ones)
const libCards = () => [...document.querySelectorAll('#course-lib .cm-card:not(.hidden)')];

function openCourseModal() {
  $('course-modal').classList.remove('hidden');
  $('course-modal').style.display = 'flex';
  $('course-close').classList.toggle('hidden', !state?.loaded);
  $('course-q').value = '';
  $('course-results').innerHTML = '';
  $('course-msg').textContent = '';
  renderLibrary();
  loadLibrary();
  setTimeout(() => $('course-q').focus(), 0);
}
function closeCourseModal() {
  $('course-modal').style.display = 'none';
}
async function loadLibrary() {
  try {
    const r = await fetch('/api/courses');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    library = await r.json();
  } catch (_) { return; }   // the server is starting: keep what is shown
  if ($('course-modal').style.display !== 'none') renderLibrary();
}

// the holes as a little map: each hole's line of play, its green a dot
function sketchSvg(sk) {
  if (!sk) return '<svg viewBox="0 0 24 24" class="cm-flag" aria-hidden="true"><path d="M7 20.5V4l9 3.6-9 3.6"/><path d="M4 20.5h16"/></svg>';
  const pad = 0.06, w = sk.w + 2 * pad, h = sk.h + 2 * pad;
  const lines = sk.holes.map((l) => `<polyline points="${l.map(([x, y]) => `${(x + pad).toFixed(3)},${(y + pad).toFixed(3)}`).join(' ')}"/>`).join('');
  const greens = sk.holes.map((l) => { const [x, y] = l[l.length - 1]; return `<circle cx="${(x + pad).toFixed(3)}" cy="${(y + pad).toFixed(3)}" r="0.022"/>`; }).join('');
  return `<svg viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><g class="cm-lines">${lines}</g><g class="cm-greens">${greens}</g></svg>`;
}
function playedAgo(ms) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'played just now';
  if (m < 60) return `played ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `played ${h} h ago`;
  const d = Math.round(h / 24);
  return d < 45 ? `played ${d} days ago` : 'played a while ago';
}
function cardHtml(c, kind, i) {
  const stats = [c.holes ? `${c.holes} holes` : null, c.par ? `Par ${c.par}` : null,
    c.yards ? `${Math.round(c.yards).toLocaleString('en-US')} yd` : null].filter(Boolean).join(' · ');
  const tags = kind === 'featured'
    ? '<i class="tag get">Download</i>' + (c.researched ? '<i class="tag">Scorecard</i>' : '')
    : (c.current ? '<i class="tag now">Playing</i>' : '') + (c.hd ? '<i class="tag">HD</i>' : '') +
      (c.researched ? '<i class="tag">Scorecard</i>' : '') + (playedAgo(c.lastUsed) ? `<i class="tag dim">${playedAgo(c.lastUsed)}</i>` : '');
  const words = `${c.name} ${c.place || ''}`.toLowerCase();
  return `<button type="button" class="cm-card${c.current ? ' current' : ''}" data-kind="${kind}" data-i="${i}" data-words="${esc(words)}">
    <span class="cm-map">${kind === 'featured' ? sketchSvg(null) : sketchSvg(c.sketch)}</span>
    <span class="cm-body"><b class="cm-name">${esc(c.name.split(',')[0])}</b>${c.place ? `<span class="cm-place">${esc(c.place)}</span>` : ''}
      ${stats ? `<span class="cm-stats">${stats}</span>` : ''}<span class="cm-tags">${tags}</span></span>
  </button>`;
}
function renderLibrary() {
  const el = $('course-lib');
  if (!library) { el.innerHTML = '<div class="cm-empty"><span class="loading-spin"></span>Loading your courses…</div>'; return; }
  const yours = library.courses || [], feat = library.featured || [];
  el.innerHTML =
    (yours.length ? `<div class="cm-sec"><span class="lbl">YOUR COURSES · <b data-count="yours">${yours.length}</b></span><span class="cm-sub">Downloaded, so they load in seconds</span></div>
      <div class="cm-grid" data-sec="yours">${yours.map((c, i) => cardHtml(c, 'yours', i)).join('')}</div>` : '') +
    (feat.length ? `<div class="cm-sec"><span class="lbl">FEATURED · <b data-count="featured">${feat.length}</b></span><span class="cm-sub">A click downloads one: about a minute the first time</span></div>
      <div class="cm-grid" data-sec="featured">${feat.map((c, i) => cardHtml(c, 'featured', i)).join('')}</div>` : '') +
    '<div id="cm-none" class="cm-empty hidden"></div>';
  el.querySelectorAll('.cm-card').forEach((card) => { card.onclick = () => playCard(card); });
  applyFilter();
}
// show the cards with a word starting with each word typed (name or place); pick the first
const wordsOf = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function applyFilter() {
  const q = $('course-q').value.trim().toLowerCase();
  const words = wordsOf(q);
  for (const card of document.querySelectorAll('#course-lib .cm-card')) {
    const have = wordsOf(card.dataset.words);
    card.classList.toggle('hidden', !words.every((w) => have.some((h) => h.startsWith(w))));
  }
  for (const sec of ['yours', 'featured']) {
    const n = document.querySelectorAll(`#course-lib .cm-grid[data-sec="${sec}"] .cm-card:not(.hidden)`).length;
    const b = document.querySelector(`#course-lib [data-count="${sec}"]`);
    if (b) b.textContent = n;
    const grid = document.querySelector(`#course-lib .cm-grid[data-sec="${sec}"]`);
    if (grid) { grid.classList.toggle('hidden', !n); grid.previousElementSibling.classList.toggle('hidden', !n); }
  }
  const none = $('cm-none');
  const shown = libCards().length;
  if (none) {
    none.classList.toggle('hidden', !!shown || !q);
    none.innerHTML = q ? `Nothing here called “${esc(q)}”. Press <kbd>Enter</kbd> to search the map for it.` : '';
  }
  markLibSel(words.length && shown ? 0 : -1);
}
function markLibSel(i) {
  const cards = libCards();
  libSel = cards.length ? Math.max(-1, Math.min(cards.length - 1, i)) : -1;
  document.querySelectorAll('#course-lib .cm-card.sel').forEach((c) => c.classList.remove('sel'));
  if (libSel >= 0) cards[libSel].classList.add('sel');
  if (libSel >= 0) cards[libSel].scrollIntoView({ block: 'nearest' });
}
async function playCard(card) {
  const c = card.dataset.kind === 'featured' ? library.featured[+card.dataset.i] : library.courses[+card.dataset.i];
  if (!c) return;
  if (c.current && state?.loaded) { closeCourseModal(); return; }
  document.querySelectorAll('#course-lib .cm-card.loading').forEach((x) => x.classList.remove('loading'));
  card.classList.add('loading');
  await pickCourse(c.file ? { cached: c.file, name: c.name } : { osmType: c.osmType, osmId: c.osmId, name: c.name, lat: c.lat, lon: c.lon });
  card.classList.remove('loading');
}

async function doSearch(q) {
  if (!q.trim()) return;
  const msg = $('course-msg');
  msg.className = 'muted';
  msg.innerHTML = '<span class="loading-spin"></span>searching the map (OpenStreetMap)…';
  $('course-results').innerHTML = '';
  try {
    const rows = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    if (rows.error) throw new Error(rows.error);
    msg.textContent = rows.length ? '' : 'No golf course found on the map: try the course name plus its town.';
    if (rows.length) $('course-results').innerHTML = '<div class="cm-sec"><span class="lbl">ON THE MAP</span><span class="cm-sub">A click downloads it: 10 to 90 s the first time</span></div>';
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'result';
      const isCourse = r.type === 'golf_course';
      d.innerHTML = `<span class="badge ${isCourse ? '' : 'other'}">${isCourse ? 'golf course' : esc(r.type)}</span> ${esc(r.name)}`;
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
  const name = esc((body.name || 'the course').split(',')[0]);
  msg.innerHTML = body.cached ? `<span class="loading-spin"></span>Loading ${name}…`
    : `<span class="loading-spin"></span>Downloading ${name}: course and terrain from open data, 10 to 90 s the first time…`;
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
$('course-q').addEventListener('input', applyFilter);
$('course-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    markLibSel(libSel + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter') {
    const card = libCards()[libSel];
    if (card) playCard(card);
    else doSearch($('course-q').value);
  }
});
$('course-close').onclick = closeCourseModal;
$('course-modal').addEventListener('keydown', (e) => { if (e.key === 'Escape' && state?.loaded) closeCourseModal(); });
// a click on the dimmed course behind closes it (once a course is loaded)
$('course-modal').addEventListener('pointerdown', (e) => { if (e.target === $('course-modal') && state?.loaded) closeCourseModal(); });
// the course name, top left, switches course
$('course-name').onclick = () => openCourseModal();

// ---------- boot ----------
(async () => {
  try {
    await loadGeometry();
    const s = await (await fetch('/api/state')).json();
    applyState(s);
    loadLibrary();
    if (!s.loaded) openCourseModal();
    else closeCourseModal();
  } catch (err) {
    console.error('boot failed', err);
  }
})();
