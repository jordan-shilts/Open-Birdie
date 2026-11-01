'use strict';
// Course selection regressions (St Andrews quick pick loaded the "Old Course
// Starter Hut" building: a 3 m boundary made every shot OB, 3 drives = 6 shots).
// All network is stubbed; no request leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring course.js: CACHE_DIR is a load-time const.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-selection-'));
process.env.BIRDIE_DATA_DIR = dataDir;

const {
  loadCourse, makeSurfaceLookup, boundaryProblem, overpass, CourseLoadError,
} = require('../lib/course');
const { createCourseActivationManager } = require('../lib/course-activation');
const { Game } = require('../lib/game');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// A mirror that accepts the request and never answers (until its signal aborts).
function hang(_url, { signal }) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// ---------- boundary sanity guard ----------

// The cached bad load (data/courses/osm-way-1428245318.json): the starter hut's
// 7-point outline as the course boundary, holes 1 and 18 only.
const HUT_BOUNDARY = [
  [419.7, -365.98], [422.22, -365.95], [422.26, -368.88], [419.69, -368.91],
  [419.04, -368.43], [419.03, -366.52], [419.7, -365.98],
];
const HUT_HOLES = [
  { ref: 1, par: 4, tee: [414.58, -389.06], pin: [81.67, -364.61], lengthYd: 365,
    line: [[414.58, -389.06], [200, -380], [81.67, -364.61]] },
  { ref: 18, par: 4, tee: [61.18, -410.32], pin: [395.22, -437.97], lengthYd: 367,
    line: [[61.18, -410.32], [395.22, -437.97]] },
];
const hutCourse = () => ({
  name: 'Old Course Starter Hut', surfaces: [], elevation: null,
  boundary: HUT_BOUNDARY.map((p) => [...p]), holes: structuredClone(HUT_HOLES),
});

test('a 3 m starter-hut boundary is rejected and never makes a shot OB', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.match(boundaryProblem(hutCourse()), /too small/);
  const at = makeSurfaceLookup(hutCourse());
  for (const h of HUT_HOLES) {
    assert.equal(at(h.tee[0], h.tee[1]), 'rough');
    assert.equal(at(h.pin[0], h.pin[1]), 'rough');
  }
  assert.equal(at(250, -200), 'rough');
});

test('replay of the bug: three drives on the hut course cost no penalty strokes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const g = new Game();
  g.setCourse(hutCourse());
  // Aim well right of the pin so no drive can finish the hole early.
  const drive = { Speed: 150, VLA: 12, HLA: 20, TotalSpin: 2600, SpinAxis: 0 };
  for (let i = 1; i <= 3; i++) {
    const r = g.handleShot(drive, 'DR');
    assert.ok(r, `drive ${i} resolves`);
    assert.equal(r.penalty, 0, `drive ${i}: ${r.note}`);
    assert.notEqual(r.lie, 'ob');
  }
  assert.equal(g.holed, false);
  assert.equal(g.strokes, 3, 'before the fix: 6 (every drive +1 OB)');
});

const square = (half) => [[-half, -half], [half, -half], [half, half], [-half, half]];
const plainCourse = (boundary) => ({
  name: 'Square Links', surfaces: [], elevation: null, boundary,
  holes: [{ ref: 1, par: 4, tee: [0, -150], pin: [0, 150], lengthYd: 330, line: [[0, -150], [0, 150]] }],
});

test('a plausible course boundary still defines OB, with the 15 m buffer', () => {
  const course = plainCourse(square(300));
  assert.equal(boundaryProblem(course), null);
  const at = makeSurfaceLookup(course);
  assert.equal(at(0, 0), 'rough');
  assert.equal(at(310, 0), 'rough', 'near miss inside the buffer stays in play');
  assert.equal(at(400, 0), 'ob');
});

test('a boundary that leaves out a tee or pin, or is degenerate, is not used for OB', (t) => {
  t.mock.method(console, 'warn', () => {});
  // e.g. a neighbouring course's outline: big enough, but this hole's tee is outside it
  const shifted = square(300).map(([x, y]) => [x, y + 400]);
  assert.match(boundaryProblem(plainCourse(shifted)), /tee/);
  assert.equal(makeSurfaceLookup(plainCourse(shifted))(0, -150), 'rough');
  assert.match(boundaryProblem(plainCourse(square(300).map(([x, y]) => [x, y - 400]))), /pin/);
  assert.equal(boundaryProblem(plainCourse([[0, 0], [10, 10]])), 'not a polygon');
  assert.equal(boundaryProblem(plainCourse(null)), null, 'no boundary is simply no OB');
});

// ---------- Overpass timeout + backoff ----------

let mirrorSeq = 0;
const mirrors = (n) => {
  mirrorSeq++;
  return Array.from({ length: n }, (_, i) => `https://m${i}.run${mirrorSeq}.test/api/interpreter`);
};
const fast = { timeoutMs: 50, backoffMs: 10, rounds: 3 };

test('a hung mirror times out and the next mirror answers', async () => {
  const endpoints = mirrors(2);
  const seen = [];
  let hungSignal = null;
  const fetchImpl = (url, init) => {
    seen.push(url);
    if (url === endpoints[0]) { hungSignal = init.signal; return hang(url, init); }
    return Promise.resolve(response({ elements: [{ id: 1 }] }));
  };
  const t0 = Date.now();
  const data = await overpass('[out:json];way(1);out;', { ...fast, endpoints, fetchImpl });
  assert.deepEqual(data, { elements: [{ id: 1 }] });
  assert.deepEqual(seen, endpoints);
  assert.equal(hungSignal.aborted, true, 'the hung request was cancelled');
  assert.ok(Date.now() - t0 < 1000, 'did not wait on the hung mirror');
});

test('every mirror hung: fails in bounded time with a clear error, no repeat waits', async () => {
  const endpoints = mirrors(3);
  const seen = [];
  const fetchImpl = (url, init) => { seen.push(url); return hang(url, init); };
  const t0 = Date.now();
  await assert.rejects(
    overpass('q', { ...fast, endpoints, fetchImpl }),
    (err) => {
      assert.ok(err instanceof CourseLoadError);
      assert.equal(err.code, 'OVERPASS_UNAVAILABLE');
      assert.equal(err.userFacing, true);
      assert.match(err.message, /busy or not responding/);
      assert.match(err.message, /m0\.run\d+\.test: no reply in/);
      return true;
    },
  );
  assert.deepEqual(seen, endpoints, 'each hung mirror is tried once per call');
  assert.ok(Date.now() - t0 < 3 * fast.timeoutMs + 500);
});

test('busy (502/429) mirrors are retried with exponential backoff', async () => {
  const endpoints = mirrors(1);
  const statuses = [502, 429, 200];
  const at = [];
  const fetchImpl = async () => {
    at.push(Date.now());
    const status = statuses.shift();
    return response(status === 200 ? { elements: [] } : 'at capacity', status);
  };
  const data = await overpass('q', { ...fast, backoffMs: 40, endpoints, fetchImpl });
  assert.deepEqual(data, { elements: [] });
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 35, `first backoff ~40 ms (was ${at[1] - at[0]})`);
  assert.ok(at[2] - at[1] >= 75, `second backoff ~80 ms (was ${at[2] - at[1]})`);
});

test('all mirrors busy: gives up after the configured rounds and names each mirror', async () => {
  const endpoints = mirrors(2);
  let calls = 0;
  const fetchImpl = async () => { calls++; return response('at capacity', 502); };
  await assert.rejects(overpass('q', { ...fast, endpoints, fetchImpl }), (err) => {
    assert.equal(err.code, 'OVERPASS_UNAVAILABLE');
    assert.match(err.message, /m0\.run\d+\.test: HTTP 502; m1\.run\d+\.test: HTTP 502/);
    return true;
  });
  assert.equal(calls, fast.rounds * endpoints.length);
});

test('a bad query (400) fails at once instead of walking every mirror', async () => {
  const endpoints = mirrors(3);
  let calls = 0;
  const fetchImpl = async () => { calls++; return response('parse error: line 1', 400); };
  await assert.rejects(overpass('bad', { ...fast, endpoints, fetchImpl }), /Overpass 400 .*parse error/);
  assert.equal(calls, 1);
});

test('the caller aborting is not mistaken for a mirror timeout', async () => {
  const endpoints = mirrors(2);
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (url, init) => { calls++; return hang(url, init); };
  const pending = overpass('q', { timeoutMs: 5_000, endpoints, fetchImpl, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(calls, 1, 'no further mirrors after the caller gave up');
});

test('the mirror that answered last is tried first next time', async () => {
  const endpoints = mirrors(2);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url === endpoints[0] ? response('at capacity', 502) : response({ elements: [] });
  };
  await overpass('q1', { ...fast, endpoints, fetchImpl });
  seen.length = 0;
  await overpass('q2', { ...fast, endpoints, fetchImpl });
  assert.deepEqual(seen, [endpoints[1]]);
});

// ---------- refusing a non-golf-course feature ----------

test('loading the starter hut is refused with a clear message and nothing is cached', async (t) => {
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    posts.push(decodeURIComponent(String(init.body || '')));
    return response({
      elements: [{
        type: 'way', id: 1428245318,
        tags: { building: 'yes', name: 'Old Course Starter Hut' },
        geometry: [
          { lat: 56.34706, lon: -2.80950 }, { lat: 56.34706, lon: -2.80946 },
          { lat: 56.34703, lon: -2.80946 }, { lat: 56.34703, lon: -2.80950 },
          { lat: 56.34706, lon: -2.80950 },
        ],
      }],
    });
  });
  const request = {
    name: 'Old Course Starter Hut, Golf Place, Town Centre, St Andrews',
    osmType: 'way', osmId: 1428245318,
    bbox: [56.3470, 56.3471, -2.8095, -2.8094],
  };
  await assert.rejects(loadCourse(request), (err) => {
    assert.ok(err instanceof CourseLoadError);
    assert.equal(err.code, 'COURSE_NOT_GOLF_COURSE');
    assert.equal(err.userFacing, true);
    assert.match(err.message, /"Old Course Starter Hut"/);
    assert.match(err.message, /building=yes/);
    assert.match(err.message, /not as a golf course/);
    assert.match(err.recovery, /golf course/);
    return true;
  });
  assert.equal(posts.length, 1, 'no surface/hole download after the refusal');
  const cached = fs.existsSync(path.join(dataDir, 'courses'))
    ? fs.readdirSync(path.join(dataDir, 'courses')) : [];
  assert.deepEqual(cached, []);
});

test('activation shows a user-facing load refusal but keeps other failures generic', async () => {
  const manager = createCourseActivationManager({
    acquireCourse: async (request) => {
      if (request.osmId === 1) {
        throw new CourseLoadError('COURSE_NOT_GOLF_COURSE', '"Old Course Starter Hut" is not a golf course.',
          'Search again and pick a result marked "golf course".');
      }
      throw new Error('C:\\Users\\alice\\secret?token=hunter2');
    },
    prepareCandidate: async () => { throw new Error('unreachable'); },
    commitPreparedActivation: () => { throw new Error('unreachable'); },
  });
  const refused = await manager.activate({ osmType: 'way', osmId: 1 });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.diagnostic.code, 'COURSE_NOT_GOLF_COURSE');
  assert.match(refused.diagnostic.message, /Starter Hut/);
  assert.match(refused.diagnostic.recovery, /golf course/);
  const generic = await manager.activate({ osmType: 'way', osmId: 2 });
  assert.equal(generic.diagnostic.code, 'ACTIVATION_PREPARE_FAILED');
  assert.doesNotMatch(JSON.stringify(generic), /alice|hunter2|secret/);
});
