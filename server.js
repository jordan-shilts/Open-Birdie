'use strict';
// Open-Birdie — open-data golf simulator.
//   HTTP  : http://localhost:8222  (game UI + API, Server-Sent Events)
//   TCP   : port 921               (GSPro Open Connect — point GSPconnect here)
// Zero npm dependencies; needs Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { OpenConnectServer, toOpenConnectClub } = require('./lib/openconnect');
const { searchCourses, loadCourse, listCached, loadCached } = require('./lib/course');
const {
  cloudConfigFromEnv,
  cloudSceneryProviders,
  createCloudClient,
  createCloudCourseSource,
} = require('./lib/cloud-client');
const { createCourseActivationManager } = require('./lib/course-activation');
const { createCourseCache } = require('./lib/course-cache');
const {
  applySceneryUpdate,
  createSceneryEnricher,
  localSceneryProviders,
} = require('./lib/course-enrichment');
const { serveCourseArtRequest } = require('./lib/course-art-http');
const { createCourseDiagnostic, sanitizePublicText } = require('./lib/course-diagnostics');
const { normalizeCourseSource } = require('./lib/course-identity');
const { packageKeyFor, parsePackageKey } = require('./lib/course-package');
const { prepareCourseCandidate } = require('./lib/resolved-course-package');
const { Game, CLUB_FULL } = require('./lib/game');
const { PRESETS, conditionsState, loadConditionsFile, saveConditionsFile } = require('./lib/conditions');
const { createBag } = require('./lib/bag');
const { createSavedShots } = require('./lib/saved-shots');
const { PredictError, predictCarries, predictShot } = require('./lib/predict');
const { serveHdAsset, publicHdMetadata, pickDescriptor } = require('./lib/hd-http');
const { makeNonce, verifyReadinessAck } = require('./lib/hd-readiness');
const { googleTilesConfig } = require('./lib/google-tiles-config');

const HTTP_PORT = +(process.env.BIRDIE_PORT || 8222);
const OC_PORT = +(process.env.BIRDIE_OC_PORT || 921);
// Bind the HTTP API to localhost by default — its mutating endpoints (reset,
// load-course, test-shot) are unauthenticated, so don't expose them to the LAN
// unless explicitly opted in. Set BIRDIE_HOST=0.0.0.0 for tablet/phone mirroring
// on a TRUSTED network only.
const HTTP_HOST = process.env.BIRDIE_HOST || '127.0.0.1';
// Correct ball speed for monitors/bridges that report m/s instead of mph
// (m/s plays ~2.2x short). e.g. BIRDIE_SPEED_SCALE=2.23694 for a metric monitor.
const SPEED_SCALE = +(process.env.BIRDIE_SPEED_SCALE || 1);
const PUB = path.join(__dirname, 'public');
const DATA_DIR = process.env.BIRDIE_DATA_DIR || path.join(__dirname, 'data');
const ART_DIR = process.env.BIRDIE_ART_DIR || path.join(__dirname, 'build', 'course-art');
// Background scenery (buildings, real trees, aerial photo) for every course that is
// missing it. BIRDIE_ENRICH=0 turns it off (offline play, tests, visual capture).
const SCENERY_ENABLED = process.env.BIRDIE_ENRICH !== '0';
// Bounded local course cache (BIRDIE_CACHE_MAX_MB, default 1024): least recently
// played courses are deleted past the cap, never the active one.
const courseCache = createCourseCache({ dataDir: DATA_DIR });
// Cloud course service (BIRDIE_CLOUD_URL): courses and their scenery are downloaded
// as verified packages instead of being built here. Unset = no cloud request ever.
const CLOUD = cloudConfigFromEnv(process.env, console, { file: path.join(DATA_DIR, 'cloud.json') });
const cloudClient = CLOUD ? createCloudClient(CLOUD) : null;

const game = new Game();
// Playing conditions persist across restarts (a bad or missing file: standard conditions).
const CONDITIONS_FILE = path.join(DATA_DIR, 'conditions.json');
{
  const saved = loadConditionsFile(CONDITIONS_FILE);
  if (saved) game.setConditions(saved);
}
// The player's bag: per-club launch history from the launch monitor (lib/bag.js),
// which the lineup predicts with (lib/predict.js reads game.bag).
const bag = createBag({ dataDir: DATA_DIR });
game.bag = bag;
// The player's saved shots (lib/saved-shots.js), and the last shot played: the one a
// save applies to, with where it was hit from.
const saved = createSavedShots({ dataDir: DATA_DIR });
let shotSeq = 0;
let lastShot = null;
const sseClients = new Set();
// HD bundle runtime state, kept OUTSIDE the serializable course object so absolute
// paths + Float32 heights never leak through course JSON. An ARRAY — one descriptor
// per built hole — so the whole course renders real 1 m relief, not just one hole.
let activeHd = [];       // resolved descriptors (server-only paths); [] when none
let courseRevision = 0;  // bumped on each course activation
// Per-process secret handed only to the loopback Electron primary client; an HD
// revision activates only on a nonce-matched ack from it.
const PRIMARY_NONCE = makeNonce();
const READY_TIMEOUT_MS = +(process.env.BIRDIE_HD_READY_TIMEOUT_MS || 15000);
let readyTimer = null;
const isLoopbackAddr = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

let lmStatus = { connected: false, ready: false };

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---------- Open Connect (launch monitor) ----------
const oc = new OpenConnectServer(OC_PORT);
oc.on('listening', (p) => console.log(`[OC] Open Connect listening on TCP ${p} — point GSPconnect/Uneekor VIEW at this PC`));
oc.on('connected', (addr) => {
  lmStatus.connected = true;
  console.log(`[OC] launch monitor connected from ${addr}`);
  broadcast('lm', lmStatus);
  updatePlayerInfo();
});
oc.on('disconnected', () => {
  lmStatus.connected = oc.clientCount > 0;
  broadcast('lm', lmStatus);
});
oc.on('status', (s) => { lmStatus.ready = s.ready; broadcast('lm', lmStatus); });
oc.on('shot', (shot) => {
  if (SPEED_SCALE !== 1 && typeof shot.ball.Speed === 'number') shot.ball.Speed *= SPEED_SCALE;
  console.log(`[OC] shot: ${shot.ball.Speed} mph, VLA ${shot.ball.VLA}, HLA ${shot.ball.HLA}, spin ${shot.ball.TotalSpin}${shot.clubName ? ' (' + shot.clubName + ')' : ''}`);
  const from = shotOrigin();
  const result = playShot(shot.ball, shot.clubName);
  recordBagShot(shot, result, from);
});
oc.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[OC] Port ${OC_PORT} is in use — close GSPro (it uses the same Open Connect port) and restart.`);
  } else console.error('[OC]', err.message);
});

function playShot(ballData, clubName) {
  const before = game.course ? game.state() : null;   // where the ball is hit from
  const result = game.handleShot(ballData, clubName);
  if (!result) return null;
  result.shotId = ++shotSeq;
  const pr = before.practice || null;
  lastShot = {
    result,
    context: {
      shotId: result.shotId, at: Date.now(), course: before.courseName,
      hole: pr ? null : before.hole, holeRef: pr ? (pr.holeRef ?? null) : before.holeRef, practice: pr ? pr.mode : null,
      club: result.clubKey || result.club || null, pin: before.pin, tee: before.tee, aimDeg: before.aimDeg,
    },
  };
  broadcast('shot', result);
  broadcast('state', game.state());
  updatePlayerInfo();
  return result;
}

// Where the next ball is hit from, for the bag's history.
function shotOrigin() {
  if (!game.course) return {};
  const p = game.practice;
  if (p) {
    return { course: game.course.name, practice: p.mode, lie: p.lie, ...(p.target.ref != null ? { hole: p.target.ref } : {}) };
  }
  return { course: game.course.name, hole: game.hole ? (game.hole.ref ?? game.holeIndex + 1) : null, lie: game.lie };
}

// Every full launch-monitor shot goes into the player's bag (not putts, not mishits;
// /api/test-shot never comes through here).
function recordBagShot(shot, result, from) {
  const r = bag.recordShot({
    ball: shot.ball,
    clubName: shot.clubName,
    selectedClub: game.selectedClub,
    isPutt: Boolean(result && result.sim && result.sim.isPutt),
    meta: { ...from, at: Date.now() },
  });
  if (r.recorded) broadcast('bag', { club: r.club, n: r.n, total: bag.total });
  else if (r.reason !== 'putt') console.log(`[bag] shot not recorded: ${r.reason}${r.club ? ` (${r.club})` : ''}`);
}

// Prediction routes: a PredictError is the caller's (bad club / aim) or the game's
// (no course, not ready, hole finished) state, not a server failure.
function predictRoute(res, fn) {
  try {
    return json(res, fn());
  } catch (error) {
    if (error instanceof PredictError) return json(res, { ok: false, error: error.message, code: error.code }, error.status);
    throw error;
  }
}

function updatePlayerInfo() {
  if (!game.course) return;
  // the round's pin, or the practice target while on the range / in a mini game
  oc.setPlayer({ DistanceToTarget: Math.round(game.state().distToPinYd) });
}

function deriveActivationSource(request) {
  if (request?.source || (request?.osmType && request?.osmId != null)) {
    return normalizeCourseSource(request.source || request);
  }
  if (request?.cached) {
    const cachedCourse = loadCached(request.cached);
    if (cachedCourse?.source) return normalizeCourseSource(cachedCourse.source);
  }
  return normalizeCourseSource(null);
}

async function acquireActivationCourse(request, { abortDifferent, source }) {
  const preloadedCourse = request.cached ? loadCached(request.cached) : null;
  return loadCourse(request, {
    abortDifferent,
    source,
    ...(preloadedCourse ? { preloadedCourse } : {}),
    // not cached here: try the cloud's package before building it locally
    ...(cloudCourses ? { remote: cloudCourses.acquire } : {}),
  });
}

function commitPreparedActivation({ candidate, resolvedPackage }) {
  let nextTimer = null;
  if (candidate.hdDescriptors.length) {
    const revision = resolvedPackage.courseRevision;
    nextTimer = setTimeout(() => {
      if (!game.runtimeReady && courseRevision === revision) {
        console.warn('[hd] readiness timeout — activating procedural fallback');
        game.activateRuntimeTerrain([]);
        broadcast('state', game.state());
      }
    }, READY_TIMEOUT_MS);
    if (nextTimer.unref) nextTimer.unref();
  }

  game.commitPreparedCourse(candidate.preparedGameState);
  activeHd = candidate.hdDescriptors;
  courseRevision = resolvedPackage.courseRevision;
  const previousTimer = readyTimer;
  readyTimer = nextTimer;
  if (previousTimer) clearTimeout(previousTimer);
}

// A finished scenery layer: put it on the live course (only if that course is still
// the active one) and tell clients to refresh their scenery. Gameplay never reads
// these fields, so the round in progress is untouched.
function applyActiveScenery({ courseId, layer, course }) {
  const current = activationManager.current();
  if (!current || current.courseId !== courseId || !applySceneryUpdate(game.course, course)) return;
  console.log(`[scenery] ${layer} ready for ${courseId}`);
  broadcast('scenery', { courseId, courseRevision: current.courseRevision, layers: [layer] });
}

// Keep the cache under its cap; the active course (and any extra key, e.g. one
// being installed) is never evicted.
function trimCourseCache(...extraKeys) {
  const keep = [...extraKeys];
  const current = activationManager.current();
  if (current) {
    try { keep.push(packageKeyFor(parsePackageKey(current.courseId))); } catch (_) { /* no key form */ }
  }
  try { courseCache.enforce({ protect: keep }); }
  catch (error) { console.warn(`[cache] trim failed: ${error.message}`); }
}

const cloudCourses = cloudClient ? createCloudCourseSource({
  client: cloudClient,
  dataDir: DATA_DIR,
  onProgress: (progress) => broadcast('course-progress', progress),
  onInstalled({ key, manifest }) {
    courseCache.record(key, { origin: 'cloud', packageId: manifest.packageId, lastUsed: Date.now() });
    trimCourseCache(key);
  },
}) : null;

const sceneryEnricher = SCENERY_ENABLED ? createSceneryEnricher({
  cacheDir: path.join(DATA_DIR, 'courses'),
  // with a cloud, a course installed from a base package upgrades to the cloud's
  // tiled aerial once it is there
  aerialQuality: cloudClient ? 'tiled' : 'single',
  // With a cloud, scenery comes from the course's cloud package; buildings and the
  // single-request aerial can still be fetched here if the cloud cannot supply
  // them, but canopy (geotiff) only ever comes from the cloud.
  providers: cloudClient
    ? cloudSceneryProviders({ client: cloudClient, fallback: localSceneryProviders({ canopy: false }) })
    : localSceneryProviders(),
  onLayer(event) {
    applyActiveScenery(event);
    const key = packageKeyFor(event.course.source);
    courseCache.record(key); // the course grew
    trimCourseCache(key);
  },
  onProgress: (progress) => broadcast('course-progress', progress),
}) : null;

const activationManager = createCourseActivationManager({
  deriveSource: deriveActivationSource,
  acquireCourse: acquireActivationCourse,
  prepareCandidate: ({ course, source }) => prepareCourseCandidate({
    baseCourse: course,
    requestedIdentity: source,
    packsEnabled: process.env.BIRDIE_DISABLE_CURATED !== '1',
    dataDir: DATA_DIR,
    artDir: ART_DIR,
    prepareGame: (gameplayCourse, options) => game.prepareCourse(gameplayCourse, options),
  }),
  commitPreparedActivation,
  onPrepareFailed(error, { courseId }) {
    const cause = createCourseDiagnostic({
      code: error?.code || error?.name || 'ACTIVATION_PREPARE_FAILED',
      severity: 'error',
      stage: 'activation-private',
      courseId,
      message: sanitizePublicText(
        error?.message,
        'Course activation preparation failed.',
      ),
      recovery: 'Inspect the private activation log and retry the course.',
    });
    console.error(`[course] activation prepare failed: ${JSON.stringify(cause)}`);
  },
  onCommitted({ resolvedPackage, candidate }) {
    if (activeHd.length) {
      console.log(`[hd] ${activeHd.length} bundle(s) active: hole(s) ${activeHd.map((d) => d.hole).join(', ')}`);
    }
    updatePlayerInfo();
    broadcast('course', {
      name: candidate.gameplayCourse.name,
      courseId: resolvedPackage.courseId,
      courseRevision: resolvedPackage.courseRevision,
      contentRevision: resolvedPackage.contentRevision,
    });
    broadcast('state', game.state());
    const key = packageKeyFor(candidate.baseCourse.source);
    courseCache.touch(key);
    trimCourseCache(key);
    // The course is playable now; missing scenery follows in the background.
    if (sceneryEnricher) {
      sceneryEnricher.schedule({ source: candidate.baseCourse.source, course: candidate.baseCourse });
    }
  },
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
// ES modules served from node_modules (keeps the app fully offline-capable). three.js is
// always used; 3d-tiles-renderer is only fetched when Google 3D tiles are configured.
const VENDOR = { '/vendor/three/': 'three', '/vendor/3d-tiles-renderer/': '3d-tiles-renderer' };
// Official Google Maps logo for the 3D-tiles attribution, if the user has installed it
// (else the page shows the words "Google Maps", which the Map Tiles policies allow).
const GOOGLE_LOGO = 'assets/attribution/google-maps-logo.svg';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/course-art/')) {
      return await serveCourseArtRequest(req, res, {
        artRoot: ART_DIR,
        getActivePackage: () => activationManager.current(),
        lookupPrivateAsset: (contentRevision, assetKey) => (
          activationManager.lookupPrivateAsset(contentRevision, assetKey)
        ),
        onInternalError: (error) => {
          console.error(`[course-art] request rejected internally: ${error?.message || 'unknown error'}`);
        },
      });
    }
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(game.state())}\n\n`);
      res.write(`event: lm\ndata: ${JSON.stringify(lmStatus)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/state') return json(res, game.state());
    if (p === '/api/clubs') return json(res, CLUB_FULL);
    // Shot lineup: conditions, predictions, the player's bag (lib/conditions.js,
    // lib/predict.js, lib/bag.js).
    if (p === '/api/conditions' && req.method !== 'POST') {
      return json(res, { conditions: conditionsState(game.conditions), presets: PRESETS });
    }
    if (p === '/api/predict' && req.method !== 'POST') {
      return predictRoute(res, () => predictShot(game, {
        club: url.searchParams.get('club'),
        aimOffset: url.searchParams.get('aim'),
      }));
    }
    if (p === '/api/carries' && req.method !== 'POST') return predictRoute(res, () => predictCarries(game));
    if (p === '/api/bag' && req.method !== 'POST') return json(res, bag.summary());
    // Saved shots: the list (newest first), and one with its trajectory to replay
    if (p === '/api/saved-shots' && req.method !== 'POST') {
      return json(res, { shots: saved.list(), lastShotId: lastShot ? lastShot.context.shotId : null });
    }
    if (p.startsWith('/api/saved-shots/') && req.method === 'GET') {
      const one = saved.get(decodeURIComponent(p.slice('/api/saved-shots/'.length)));
      return one ? json(res, one) : json(res, { ok: false, error: 'No such saved shot' }, 404);
    }
    if (p === '/api/courses/cached') return json(res, listCached());
    if (p === '/api/search') {
      // Raw query: appending " golf" made Nominatim match addresses like
      // "Golf Place" (St Andrews' starter hut) instead of the course itself.
      return json(res, await searchCourses(url.searchParams.get('q') || ''));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (p === '/api/load-course') {
        const result = await activationManager.activate(body);
        if (result.status === 'superseded') {
          return json(res, {
            ok: false,
            error: result.diagnostic.message,
            diagnostic: result.diagnostic,
          }, 409);
        }
        if (result.status === 'failed') {
          return json(res, {
            ok: false,
            error: result.diagnostic.message,
            diagnostic: result.diagnostic,
          }, 500);
        }
        // geometry is heavy (elevation grid) — clients refetch it themselves
        return json(res, {
          ok: true,
          holes: game.course.holes.length,
          courseId: result.package.courseId,
          courseRevision: result.package.courseRevision,
          contentRevision: result.package.contentRevision,
          ...(result.observerDiagnostic ? { diagnostics: [result.observerDiagnostic] } : {}),
        });
      }
      if (p === '/api/test-shot') {
        // practice panel / testing without a launch monitor
        playShot({
          Speed: +body.speed, VLA: +body.vla, HLA: +body.hla || 0,
          TotalSpin: +body.spin || 0, SpinAxis: +body.spinAxis || 0,
        });
        return json(res, { ok: true });
      }
      if (p === '/api/aim') {
        game.setAimOffset(body.offset);
        broadcast('state', game.state());
        return json(res, { ok: true });
      }
      // Driving range and mini games on the loaded course (lib/practice.js):
      //   {mode: range|closest|longdrive|targets|putting|chipping|ladder, targetYd?, hole?}
      //                                start (or restart); hole: the par 3 for closest, the
      //                                green for putting / chipping (default: the round's)
      //   {action: 'target', targetYd} move the range flag
      //   {action: 'end'}              back to the round
      if (p === '/api/practice') {
        if (!game.course) return json(res, { ok: false, error: 'Load a course first' }, 409);
        try {
          if (body.action === 'end') game.endPractice();
          else if (body.action === 'target') { if (game.practice) game.practice.setTarget(body.targetYd); }
          else game.startPractice(String(body.mode || 'range'), {
            targetYd: Number.isFinite(+body.targetYd) ? +body.targetYd : null,
            hole: Number.isInteger(body.hole) ? body.hole : null,
          });
        } catch (error) {
          return json(res, { ok: false, error: error.message }, 400);
        }
        updatePlayerInfo();
        broadcast('state', game.state());
        return json(res, { ok: true });
      }
      if (p === '/api/club') {
        oc.setPlayer({ Club: toOpenConnectClub(body.club) });
        const selectedClub = game.setSelectedClub(body.club);
        broadcast('state', game.state());
        return json(res, { ok: true, selectedClub });
      }
      // {preset: 'windy'} (optionally with fields on top) or a partial conditions object
      if (p === '/api/conditions') {
        let conditions;
        try {
          conditions = game.setConditions(body);
        } catch (error) {
          if (error.code !== 'UNKNOWN_PRESET') throw error;
          return json(res, { ok: false, error: error.message, code: error.code }, 400);
        }
        try { saveConditionsFile(CONDITIONS_FILE, game.conditions); }
        catch (error) { console.warn(`[conditions] could not save: ${error.message}`); }
        broadcast('state', game.state());
        return json(res, { ok: true, conditions });
      }
      if (p === '/api/bag/reset') {
        await bag.reset();
        broadcast('bag', { reset: true, total: bag.total });
        return json(res, { ok: true, bag: bag.summary() });
      }
      // {shotId}: save the shot just played (refused once another has been hit since)
      if (p === '/api/saved-shots') {
        if (!lastShot || (body.shotId != null && body.shotId !== lastShot.context.shotId)) {
          return json(res, { ok: false, error: 'That shot is no longer the last one' }, 409);
        }
        const shot = saved.add(lastShot.result, lastShot.context);
        if (!shot) return json(res, { ok: false, error: 'That shot has no flight to save' }, 422);
        broadcast('saved-shots', { count: saved.count, saved: shot.id, shotId: lastShot.context.shotId });
        return json(res, { ok: true, shot });
      }
      if (p === '/api/saved-shots/remove') {
        const id = String(body.id || '');
        const ok = saved.remove(id);
        if (ok) broadcast('saved-shots', { count: saved.count, removed: id });
        return json(res, { ok });
      }
      // Take the hole's latest shot back (lib/game.js mulligan)
      if (p === '/api/mulligan') {
        if (!game.mulligan()) return json(res, { ok: false, error: 'No shot to take back' }, 409);
        const st = game.state();
        broadcast('mulligan', { hole: st.hole, mulligans: st.mulligans[st.hole - 1] });
        broadcast('state', st);
        updatePlayerInfo();
        return json(res, { ok: true });
      }
      if (p === '/api/next-hole') {
        game.nextHole();
        updatePlayerInfo();
        broadcast('state', game.state());
        return json(res, { ok: true });
      }
      if (p === '/api/course-runtime-ready') {
        const currentPackage = activationManager.current();
        const v = verifyReadinessAck(body, {
          currentRevision: currentPackage?.courseRevision || 0,
          currentBundleIds: activeHd.map((d) => d.bundleId),
          serverNonce: PRIMARY_NONCE,
          isLoopback: isLoopbackAddr(req.socket.remoteAddress),
        });
        if (!v.ok) return json(res, { ok: false, code: v.code }, 403); // nonce never echoed
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        game.activateRuntimeTerrain(v.mode === 'hd' ? activeHd.map((d) => d.grid) : []);
        broadcast('state', game.state());
        return json(res, { ok: true, mode: v.mode });
      }
      if (p === '/api/reset') {
        game.reset();
        broadcast('state', game.state());
        return json(res, { ok: true });
      }
      if (p === '/api/settings') {
        Object.assign(game.settings, body);
        broadcast('state', game.state());
        return json(res, { ok: true });
      }
    }
    if (p.startsWith('/api/hd-assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const m = /^\/api\/hd-assets\/([^/]+)\/([^/]+)$/.exec(p);
      const d = m && pickDescriptor(activeHd, m[1]);
      if (!d) { res.writeHead(404); return res.end('not found'); }
      return serveHdAsset(req, res, d, m[2]);
    }
    if (p === '/api/course-aerial' && (req.method === 'GET' || req.method === 'HEAD')) {
      const a = game.course && game.course.aerial;
      const fname = a && a.file ? path.basename(a.file) : null; // basename strips any path traversal
      if (!fname) { res.writeHead(404); return res.end('not found'); }
      try {
        const buf = fs.readFileSync(path.join(DATA_DIR, 'courses', fname));
        res.writeHead(200, { 'Content-Type': fname.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (e) { res.writeHead(404); return res.end('not found'); }
    }
    if (p === '/api/course-classmap' && (req.method === 'GET' || req.method === 'HEAD')) {
      const a = game.course && game.course.aerial;
      const fname = a && a.classFile ? path.basename(a.classFile) : null; // basename strips any path traversal
      if (!fname) { res.writeHead(404); return res.end('not found'); }
      try {
        const buf = fs.readFileSync(path.join(DATA_DIR, 'courses', fname));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); // classmap is always PNG (data, not photo)
        return res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (e) { res.writeHead(404); return res.end('not found'); }
    }
    if (p === '/api/course-geometry') return json(res, courseGeometry());
    if (p === '/api/google-tiles-config') {
      const config = googleTilesConfig({
        loopback: isLoopbackAddr(req.socket.remoteAddress),
        logoUrl: fs.existsSync(path.join(PUB, GOOGLE_LOGO)) ? GOOGLE_LOGO : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(config));
    }

    for (const [prefix, pkg] of Object.entries(VENDOR)) {
      if (!p.startsWith(prefix)) continue;
      const base = path.join(__dirname, 'node_modules', pkg);
      const rel = path.normalize(p.slice(prefix.length)).replace(/^([.][.][/\\])+/, '');
      const tfull = path.join(base, rel);
      if (!tfull.startsWith(base) || !fs.existsSync(tfull) || !fs.statSync(tfull).isFile()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(tfull)] || 'application/octet-stream' });
      return fs.createReadStream(tfull).pipe(res);
    }

    // static
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^([.][.][/\\])+/, '');
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB) || !fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    console.error(`[HTTP] ${p}:`, err.message);
    const diagnostic = createCourseDiagnostic({
        code: 'HTTP_REQUEST_FAILED',
        severity: 'error',
        stage: 'http',
        message: 'The request could not be completed.',
        recovery: 'Retry the request.',
      });
    json(res, { ok: false, error: diagnostic.message, diagnostic }, 500);
  }
});

// True iff both bounds exist and their extents are equal (tiny epsilon for float noise).
// The classmap's staleness key: it was generated against aerial.classBounds, so if a
// manual aerial swap has since changed aerial.bounds, the pixels no longer register.
function sameBounds(x, y) {
  if (!x || !y) return false;
  const eq = (a, b) => Math.abs(a - b) < 1e-6;
  return eq(x.minX, y.minX) && eq(x.minY, y.minY) && eq(x.maxX, y.maxX) && eq(x.maxY, y.maxY);
}

function courseGeometry() {
  const activePackage = activationManager.current();
  if (!game.course || !activePackage) return null;
  const { name, surfaces, boundary, holes, trees, woods, buildings, elevation } = game.course;
  // projection origin of the course-local metres (lib/course.js parseOsm) — places
  // geographic content such as Google 3D tiles; client-only, not part of any fingerprint
  const origin = game.course.origin && Number.isFinite(game.course.origin.lat) && Number.isFinite(game.course.origin.lon)
    ? { lat: game.course.origin.lat, lon: game.course.origin.lon } : null;
  // real trees [[x, y, heightM, crownRadiusM], ...] from canopy height data (non-fingerprinted scenery)
  const canopy = game.course.canopy?.trees || null;
  // lakes/ponds around the course [{ kind: 'water', poly, name }] (non-fingerprinted
  // scenery, never part of `surfaces`: drawn, not played)
  const sceneryWater = game.course.scenery?.water || null;
  // Course-wide aerial: bounds only (the image is fetched from /api/course-aerial);
  // never leak the server file path. Drapes the whole course as the ground photo.
  // classes: advertise the runtime NDVI classmap ONLY when it's fresh — i.e. it was
  // built against these same bounds. A stale classmap (aerial hand-swapped since) would
  // sample surfaces at UV coords from the NEW bounds against OLD pixels → mis-registered;
  // mismatch => classes:false => the shader falls back to OSM-only masks (safe).
  const a = game.course.aerial;
  const aerial = a ? {
    bounds: a.bounds,
    classes: !!(a.classFile && a.classBounds && sameBounds(a.classBounds, a.bounds)),
  } : null;
  // hd is an ARRAY of sanitized metadata (one per built hole; no absolute paths,
  // no Float32 heights), or null when the course has no HD bundles.
  const hd = activeHd.length ? activeHd.map(publicHdMetadata) : null;
  return {
    name,
    origin,
    surfaces,
    boundary,
    holes,
    trees,
    woods,
    buildings,
    canopy,
    sceneryWater,
    aerial,
    elevation,
    hd,
    courseId: activePackage.courseId,
    courseRevision: activePackage.courseRevision,
    contentRevision: activePackage.contentRevision,
    presentation: activePackage.presentation,
    terrainPatches: activePackage.terrainPatches,
    assetManifest: activePackage.assetManifest,
    diagnostics: activePackage.diagnostics,
  };
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

if (SPEED_SCALE !== 1) console.log(`[OC] BIRDIE_SPEED_SCALE=${SPEED_SCALE} — scaling incoming ball speed`);
async function bootstrap() {
  if (cloudClient) {
    console.log(`[cloud] courses come from ${new URL(cloudClient.baseUrl).host}${cloudClient.canBuild ? ' (can request builds)' : ''}`);
  }
  const usage = courseCache.scan();
  if (usage.courses) {
    const limit = Number.isFinite(usage.limitBytes) ? `${Math.round(usage.limitBytes / 1048576)} MB` : 'no limit';
    console.log(`[cache] ${usage.courses} course(s), ${Math.round(usage.bytes / 1048576)} MB (cap ${limit})`);
  }
  if (!process.env.BIRDIE_NO_AUTOLOAD) {
    const cached = listCached();
    if (cached.length) {
      const result = await activationManager.activate({ cached: cached[0].file });
      if (result.status === 'committed') {
        console.log(`[course] loaded cached: ${game.course.name} (${game.course.holes.length} holes)`);
      } else {
        console.error(`[course] cache load failed: ${JSON.stringify(result.diagnostic)}`);
      }
    }
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(HTTP_PORT, HTTP_HOST, () => {
      server.off('error', onError);
      const actualPort = server.address().port;
      const exposed = HTTP_HOST !== '127.0.0.1' && HTTP_HOST !== 'localhost';
      console.log(`[HTTP] Open-Birdie UI: http://localhost:${actualPort}` +
        (exposed ? `  (exposed on ${HTTP_HOST} — trusted networks only)` : '  (localhost only — set BIRDIE_HOST=0.0.0.0 to mirror on your LAN)'));
      resolve({ httpPort: actualPort });
    });
  });
}

const ready = bootstrap();
oc.start();

function close() {
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  if (sceneryEnricher) sceneryEnricher.cancelAll();
  for (const res of sseClients) { try { res.end(); } catch (_) { /* gone */ } }
  sseClients.clear();
  try { server.close(); } catch (_) { /* already closed */ }
  try {
    oc.server.close();
    for (const s of oc.clients) s.destroy();
  } catch (_) { /* already closed */ }
}

module.exports = {
  ready,
  close,
  primaryNonce: PRIMARY_NONCE,
  activationManager,
  sceneryEnricher,
};
