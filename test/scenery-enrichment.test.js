'use strict';
// Automatic course scenery (buildings, canopy trees, aerial photo): the lib modules
// behind tools/add-*.mjs and the background enricher. Offline: Overpass, the CHM
// tiles and NAIP are all fakes; sharp is real (a devDependency).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildingsQuery, fetchBuildings, parseBuildings, promoteHeroBuilding } = require('../lib/buildings-fetch');
const { canopyBlocker, fetchCanopy } = require('../lib/canopy-fetch');
const { mercX, mercY } = require('../lib/canopy-trees');
const { fetchCourseAerial, fetchCourseAerialTiled, requestCourseAerial } = require('../lib/aerial');
const {
  applySceneryUpdate,
  createSceneryEnricher,
  enrichCourseScenery,
  hasSceneryLayer,
  localSceneryProviders,
  missingSceneryLayers,
  persistSceneryUpdate,
} = require('../lib/course-enrichment');
const { courseFingerprintV1, courseFingerprintV2 } = require('../lib/course-fingerprint');

const quiet = { log() {}, warn() {}, error() {} };
const M_PER_LAT = 111132.95;

function baseCourse(overrides = {}) {
  return {
    version: 4,
    name: 'Test Links, Somewhere',
    source: { courseId: 'osm:way:77', osmType: 'way', osmId: 77 },
    origin: { lat: 45, lon: -93 },
    surfaces: [{ kind: 'green', poly: [[-30, -30], [-20, -30], [-20, -20], [-30, -20]] }],
    boundary: null,
    holes: [{ ref: 1, par: 3, tee: [-40, -40], pin: [-25, -25], line: [[-40, -40], [-25, -25]], lengthYd: 23 }],
    trees: [[1, 2]],
    woods: [],
    elevation: { minX: -50, minY: -50, cellM: 1, nx: 101, ny: 101, baseM: 250, heights: new Array(101 * 101).fill(0) },
    ...overrides,
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// buildings
// ---------------------------------------------------------------------------
test('parseBuildings: height from tag, levels or kind; clubhouse by tag or name; relation outer ring', () => {
  const origin = { lat: 45, lon: -93 };
  const square = (lat, lon, d = 0.0001) => [
    { lat, lon }, { lat, lon: lon + d }, { lat: lat + d, lon: lon + d }, { lat: lat + d, lon },
  ];
  const buildings = parseBuildings({
    elements: [
      { type: 'way', tags: { building: 'house', height: '7.5' }, geometry: square(45, -93) },
      { type: 'way', tags: { building: 'yes', 'building:levels': '3' }, geometry: square(45.001, -93) },
      { type: 'way', tags: { building: 'clubhouse' }, geometry: square(45.002, -93) },
      { type: 'way', tags: { building: 'yes', name: 'Pro Shop' }, geometry: square(45.003, -93) },
      { type: 'relation', tags: { building: 'Retail' }, members: [{ role: 'inner', geometry: square(1, 1) }, { role: 'outer', geometry: square(45.004, -93) }] },
      { type: 'way', tags: { building: 'shed' }, geometry: [{ lat: 45, lon: -93 }, { lat: 45.1, lon: -93 }] },
    ],
  }, origin);
  assert.equal(buildings.length, 5, 'the 2-point way is dropped');
  assert.deepEqual(buildings.map((b) => b.heightM), [7.5, 9.6, 9, 9, 5]);
  assert.deepEqual(buildings.map((b) => b.clubhouse), [false, false, true, true, false]);
  assert.equal(buildings[4].kind, 'retail');
  assert.equal(buildings[3].name, 'Pro Shop');
  assert.deepEqual(buildings[0].poly[0], [0, 0], 'projected into local metres around the origin');
  const mPerLon = 111319.49 * Math.cos((45 * Math.PI) / 180);
  assert.equal(buildings[0].poly[1][0], +(0.0001 * mPerLon).toFixed(2));
});

test('promoteHeroBuilding promotes the largest footprint only when none is a clubhouse', () => {
  const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
  const list = [
    { poly: rect(5, 5), heightM: 5, clubhouse: false },
    { poly: rect(20, 10), heightM: 4, clubhouse: false },
  ];
  promoteHeroBuilding(list);
  assert.deepEqual(list.map((b) => b.clubhouse), [false, true]);
  assert.equal(list[1].heightM, 8);
  const tiny = [{ poly: rect(5, 5), heightM: 5, clubhouse: false }];
  promoteHeroBuilding(tiny);
  assert.equal(tiny[0].clubhouse, false, 'a < 60 m2 shed is not a hero');
});

test('fetchBuildings queries the padded course box through the injected Overpass fetch', async () => {
  const course = baseCourse();
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: decodeURIComponent(String(init.body).slice('data='.length)) });
    return {
      ok: true,
      json: async () => ({ elements: [{ type: 'way', tags: { building: 'yes' }, geometry: [
        { lat: 45, lon: -93 }, { lat: 45, lon: -92.9999 }, { lat: 45.0001, lon: -92.9999 }, { lat: 45.0001, lon: -93 },
      ] }] }),
    };
  };
  const buildings = await fetchBuildings(course, { fetchImpl, endpoints: ['https://overpass.invalid/api/interpreter'] });
  assert.equal(buildings.length, 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].url, 'https://overpass.invalid/api/interpreter');
  assert.equal(bodies[0].body, buildingsQuery(course));
  // course extent x/y -40..-20 (holes + green), padded by 150 m
  const south = 45 + (-40 - 150) / M_PER_LAT;
  assert.match(bodies[0].body, /way\["building"\]\(/);
  assert.ok(bodies[0].body.includes(`(${south},`), 'south edge is the padded course extent');
});

// ---------------------------------------------------------------------------
// canopy
// ---------------------------------------------------------------------------
const EARTH_R = 6378137;
const invMercX = (mx) => (mx / EARTH_R) * 180 / Math.PI;
const invMercY = (my) => (2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2) * 180 / Math.PI;

// A Web-Mercator tile covering local -60..60 m whose pixels hold canopyAt(x, y).
function fakeCanopyTile(origin, canopyAt) {
  const mPerLon = 111319.49 * Math.cos((origin.lat * Math.PI) / 180);
  const lonAt = (x) => origin.lon + x / mPerLon;
  const latAt = (y) => origin.lat + y / M_PER_LAT;
  const ox = mercX(lonAt(-60)), oyTop = mercY(latAt(60)), oyBottom = mercY(latAt(-60));
  const rx = 0.5, ry = -0.5;
  const width = Math.ceil((mercX(lonAt(60)) - ox) / rx), height = Math.ceil((oyTop - oyBottom) / -ry);
  const reads = [];
  return {
    reads,
    tile: {
      bbox: [ox, oyBottom, ox + width * rx, oyTop],
      resolution: [rx, ry],
      width,
      height,
      async readWindow([c0, r0, c1, r1]) {
        reads.push([c0, r0, c1, r1]);
        const out = new Float32Array((c1 - c0) * (r1 - r0));
        for (let r = r0; r < r1; r++) {
          for (let c = c0; c < c1; c++) {
            const lon = invMercX(ox + (c + 0.5) * rx), lat = invMercY(oyTop + (r + 0.5) * ry);
            out[(r - r0) * (c1 - c0) + (c - c0)] = canopyAt((lon - origin.lon) * mPerLon, (lat - origin.lat) * M_PER_LAT);
          }
        }
        return out;
      },
    },
  };
}

const domes = (list) => (x, y) => {
  let v = 0;
  for (const d of list) {
    const r = Math.hypot(x - d.x, y - d.y);
    if (r < d.r) v = Math.max(v, d.h * Math.sqrt(1 - (r / d.r) ** 2));
  }
  return v;
};

test('fetchCanopy samples the CHM tile into course metres and drops crowns on greens and buildings', async () => {
  const course = baseCourse({
    buildings: [{ poly: [[20, -30], [30, -30], [30, -20], [20, -20]], heightM: 5, kind: 'yes', name: null, clubhouse: false }],
  });
  const { tile, reads } = fakeCanopyTile(course.origin, domes([
    { x: 10, y: 20, h: 15, r: 5 },   // free-standing tree
    { x: -25, y: -25, h: 12, r: 4 }, // on the green: a false crown
    { x: 25, y: -25, h: 10, r: 4 },  // a roof: masked by the building footprint
  ]));
  const urls = [];
  const { canopy, stats } = await fetchCanopy(course, {
    openTile: async (url) => { urls.push(url); return tile; },
    now: () => new Date('2026-11-02T00:00:00Z'),
    log: quiet,
  });
  assert.ok(urls.length >= 1 && urls.every((u) => /\/chm\/[0-3]{9}\.tif$/.test(u)), 'z9 quadkey tile URLs');
  assert.ok(reads.length >= 1);
  assert.equal(stats.nx, 101);
  assert.equal(canopy.cellM, 1);
  assert.equal(canopy.fetchedAt, '2026-11-02T00:00:00.000Z');
  assert.match(canopy.source, /CC BY 4\.0/);
  const near = canopy.trees.find((t) => Math.hypot(t[0] - 10, t[1] - 20) < 1.5);
  assert.ok(near, 'the free-standing crown is found where it stands');
  assert.ok(Math.abs(near[2] - 15) < 1.5, `height ${near[2]} ~ 15 m`);
  const blocked = canopyBlocker(course);
  assert.ok(canopy.trees.every((t) => !blocked(t[0], t[1])), 'no tree on the green or inside the building');
  assert.ok(!canopy.trees.some((t) => Math.hypot(t[0] - 25, t[1] + 25) < 3), 'roof crown masked');
});

test('fetchCanopy reports a missing reader and unreadable tiles with distinct codes', async () => {
  const course = baseCourse();
  await assert.rejects(
    fetchCanopy(course, { openTile: async () => { const e = new Error('geotiff is not installed'); e.code = 'CANOPY_READER_UNAVAILABLE'; throw e; }, log: quiet }),
    { code: 'CANOPY_READER_UNAVAILABLE' },
  );
  await assert.rejects(
    fetchCanopy(course, { openTile: async () => { throw new Error('connection reset'); }, log: quiet }),
    { code: 'CANOPY_TILES_UNAVAILABLE' },
  );
  const providers = localSceneryProviders({ openTile: async () => { const e = new Error('no geotiff'); e.code = 'CANOPY_READER_UNAVAILABLE'; throw e; } });
  assert.deepEqual(await providers.canopy(course, { log: quiet }), { status: 'skipped', reason: 'no geotiff' });
  assert.equal(localSceneryProviders({ canopy: false }).canopy, null, 'cloud-configured desktop never reads canopy tiles');
});

// ---------------------------------------------------------------------------
// aerial
// ---------------------------------------------------------------------------
function resp(buf, ok = true, status = 200) {
  return { ok, status, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
}
function fakeJpeg(n = 2100) { const b = Buffer.alloc(n); b[0] = 0xff; b[1] = 0xd8; return b; }

test('requestCourseAerial tells imagery, no imagery (error blob) and failures apart', async () => {
  const origin = { lat: 45, lon: -93 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const ok = await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(fakeJpeg()) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.quality, 'single');
  assert.deepEqual(ok.bounds, { minX: -60, minY: -60, maxX: 160, maxY: 120 });
  assert.deepEqual(await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(Buffer.from('{"error":{"code":400}}')) }), { status: 'none' });
  assert.equal((await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(fakeJpeg(), false, 503) })).status, 'failed');
  assert.equal((await requestCourseAerial({ origin, bounds, fetchImpl: async () => { throw new Error('offline'); } })).status, 'failed');
  assert.equal(await fetchCourseAerial({ origin, bounds, fetchImpl: async () => resp(Buffer.from('tiny')) }), null, 'legacy null contract');
});

test('a fully transparent PNG (NAIPPlus outside its coverage) means no imagery; a partial one is kept', async () => {
  const { PNG } = require('pngjs');
  const pngOf = (alphaAt) => {
    const png = new PNG({ width: 400, height: 300 });
    for (let i = 0; i < 400 * 300; i++) {
      png.data[i * 4] = (i * 7) & 255; png.data[i * 4 + 1] = (i * 13) & 255; png.data[i * 4 + 2] = (i * 31) & 255;
      png.data[i * 4 + 3] = alphaAt(i);
    }
    return PNG.sync.write(png);
  };
  const origin = { lat: 56.34, lon: -2.8 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const transparent = pngOf(() => 0);
  assert.ok(transparent.length > 2000, 'bigger than the error-blob floor');
  assert.deepEqual(await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(transparent) }), { status: 'none' });
  assert.equal(await fetchCourseAerial({ origin, bounds, fetchImpl: async () => resp(transparent) }), null);
  const partial = await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(pngOf((i) => (i % 400 < 200 ? 255 : 0))) });
  assert.equal(partial.status, 'ok', 'a course on the edge of coverage keeps its half photo');
  const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 7)]);
  assert.equal((await requestCourseAerial({ origin, bounds, fetchImpl: async () => resp(broken) })).status, 'failed');
});

test('fetchCourseAerialTiled mosaics exact-size tiles with sharp and falls back to one NAIP request', async () => {
  const sharp = require('sharp');
  const origin = { lat: 45, lon: -93 };
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 60 }; // padded 220 x 180 m -> 733 x 600 px @ 0.3 m
  // noisy pixels: a flat colour compresses below the 2 KB "error blob" floor
  const jpegOf = async (url) => {
    const [w, h] = /[?&]size=(\d+),(\d+)/.exec(url).slice(1).map(Number);
    const px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24;
    return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  };
  const urls = [];
  const tiled = await fetchCourseAerialTiled({
    origin, bounds, sharp, tileM: 100,
    fetchImpl: async (url) => { urls.push(url); return resp(await jpegOf(url)); },
  });
  assert.equal(tiled.status, 'ok');
  assert.equal(tiled.quality, 'tiled');
  assert.equal(urls.length, 6, '3 x 2 tiles of 100 m');
  assert.ok(urls.every((u) => u.includes('USGSNAIPPlus')));
  const meta = await sharp(tiled.buf).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 733, 600]);
  assert.deepEqual(tiled.bounds, { minX: -60, minY: -60, maxX: 160, maxY: 120 });

  const fallbackUrls = [];
  const fallback = await fetchCourseAerialTiled({
    origin, bounds, sharp, tileM: 100,
    fetchImpl: async (url) => {
      fallbackUrls.push(url);
      if (url.includes('USGSNAIPPlus') && fallbackUrls.length > 2) return resp(Buffer.alloc(0), false, 500);
      return resp(await jpegOf(url));
    },
  });
  assert.equal(fallback.status, 'ok');
  assert.match(fallback.provider, /fallback/);
  assert.ok(fallbackUrls.at(-1).includes('USGSNAIPImagery'), 'one plain NAIP request for the whole box');
  assert.equal((await sharp(fallback.buf).metadata()).width, 733);

  const none = await fetchCourseAerialTiled({ origin, bounds, sharp, fetchImpl: async () => resp(Buffer.from('{"error":1}')) });
  assert.deepEqual(none, { status: 'none' });
});

// ---------------------------------------------------------------------------
// enrichment
// ---------------------------------------------------------------------------
test('missing layers: empty lists count, aerial upgrades only for the tiled tier, "none" expires', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  const course = baseCourse();
  assert.deepEqual(missingSceneryLayers(course, { now }), ['buildings', 'water', 'canopy', 'aerial']);
  course.buildings = [];
  course.scenery = { water: [] };
  course.canopy = { trees: [] };
  course.aerial = { file: 'osm-way-77.aerial.jpg', bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } };
  assert.deepEqual(missingSceneryLayers(course, { now }), []);
  assert.deepEqual(missingSceneryLayers(course, { now, aerialQuality: 'tiled' }), ['aerial']);
  course.aerial.quality = 'tiled';
  assert.equal(hasSceneryLayer(course, 'aerial', { aerialQuality: 'tiled', now }), true);
  delete course.aerial;
  course.enrichment = { aerial: { status: 'none', at: '2026-10-30T00:00:00Z' } };
  assert.equal(hasSceneryLayer(course, 'aerial', { now }), true, 'no imagery there: not asked again');
  course.enrichment.aerial.at = '2026-09-01T00:00:00Z';
  assert.equal(hasSceneryLayer(course, 'aerial', { now }), false, 'asked again after 30 days');
});

test('layers run buildings -> water -> canopy -> aerial, canopy sees both masks, classmap follows a new aerial', async () => {
  const course = baseCourse();
  const calls = [];
  const outcome = await enrichCourseScenery(course, {
    log: quiet,
    providers: {
      async buildings() { calls.push('buildings'); return { status: 'ok', buildings: [{ poly: [[0, 0], [1, 0], [1, 1]], heightM: 5 }] }; },
      async water() { calls.push('water'); return { status: 'ok', water: [{ kind: 'water', poly: [[30, 30], [40, 30], [40, 40]], name: 'Lake' }] }; },
      async canopy(c) { calls.push(`canopy:${c.buildings.length}:${c.scenery.water.length}`); return { status: 'ok', canopy: { trees: [[1, 2, 10, 3]] } }; },
      async aerial() { calls.push('aerial'); return { status: 'ok', buf: fakeJpeg(), bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, quality: 'single' }; },
      async classify(c) {
        calls.push('classify');
        c.aerial.classFile = 'osm-way-77.classmap.png';
        c.aerial.classBounds = c.aerial.bounds;
        return [{ file: 'osm-way-77.classmap.png', bytes: Buffer.from('png') }];
      },
    },
    onLayer: async ({ layer, artifacts }) => calls.push(`saved:${layer}:${artifacts.map((a) => a.file).join(',')}`),
  });
  assert.deepEqual(calls, [
    'buildings', 'saved:buildings:',
    'water', 'saved:water:',
    'canopy:1:1', 'saved:canopy:',
    'aerial', 'classify', 'saved:aerial:osm-way-77.aerial.jpg,osm-way-77.classmap.png',
  ]);
  assert.deepEqual(outcome.applied, ['buildings', 'water', 'canopy', 'aerial']);
  assert.deepEqual(course.scenery.water[0].kind, 'water');
  assert.equal(course.surfaces.length, 1, 'never added to the fingerprinted surfaces');
  assert.equal(course.enrichment.buildings.count, 1);
  assert.equal(course.aerial.file, 'osm-way-77.aerial.jpg');
});

test('the enricher saves each layer to the cache JSON without changing the HD fingerprint', async () => {
  const cacheDir = tempDir('birdie-scenery-');
  const course = baseCourse();
  fs.writeFileSync(path.join(cacheDir, 'osm-way-77.json'), JSON.stringify(course));
  const before = { v1: courseFingerprintV1(course), v2: courseFingerprintV2(course) };
  const layers = [];
  const progress = [];
  const enricher = createSceneryEnricher({
    cacheDir,
    log: quiet,
    providers: {
      buildings: async () => ({ status: 'ok', buildings: [] }),
      water: async () => ({ status: 'ok', water: [{ kind: 'water', poly: [[60, 60], [70, 60], [70, 70]], name: null }] }),
      canopy: async () => ({ status: 'ok', canopy: { source: 'test', trees: [[3, 4, 12, 2]] } }),
      aerial: async () => ({ status: 'ok', buf: fakeJpeg(3000), bounds: { minX: -110, minY: -110, maxX: 110, maxY: 110 }, quality: 'single' }),
    },
    onLayer: ({ courseId, layer, course: c }) => layers.push([courseId, layer, Array.isArray(c.buildings)]),
    onProgress: (p) => progress.push(p),
  });
  const outcome = await enricher.schedule({ source: course.source, course });
  assert.deepEqual(outcome.applied, ['buildings', 'water', 'canopy', 'aerial']);
  assert.deepEqual(layers.map((l) => l[1]), ['buildings', 'water', 'canopy', 'aerial']);
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'osm-way-77.json'), 'utf8'));
  assert.deepEqual(saved.buildings, []);
  assert.equal(saved.scenery.water.length, 1);
  assert.deepEqual(saved.surfaces, course.surfaces);
  assert.equal(saved.canopy.trees.length, 1);
  assert.equal(saved.aerial.file, 'osm-way-77.aerial.jpg');
  assert.equal(fs.readFileSync(path.join(cacheDir, 'osm-way-77.aerial.jpg')).length, 3000);
  assert.deepEqual({ v1: courseFingerprintV1(saved), v2: courseFingerprintV2(saved) }, before, 'scenery is not fingerprinted');
  assert.deepEqual(progress.filter((p) => !p.done).map((p) => p.layer), ['buildings', 'water', 'canopy', 'aerial']);
  assert.equal(progress.at(-1).done, true);
  assert.deepEqual(fs.readdirSync(cacheDir).filter((f) => f.includes('.tmp.')), [], 'no temporaries left');
  // A second run has nothing to do.
  assert.equal(await enricher.schedule({ source: course.source, course }), null);
});

test('a failed layer waits out its cooldown; "no imagery" is remembered on disk', async () => {
  const cacheDir = tempDir('birdie-scenery-');
  const course = baseCourse({ buildings: [], scenery: { water: [] } });
  let now = 1_000_000;
  let canopyCalls = 0;
  const enricher = createSceneryEnricher({
    cacheDir,
    log: quiet,
    clock: () => now,
    failureRetryMs: 60_000,
    providers: {
      canopy: async () => { canopyCalls++; throw new Error('S3 reset'); },
      aerial: async () => ({ status: 'none' }),
    },
  });
  const first = await enricher.schedule({ source: course.source, course });
  assert.deepEqual(first.failed, ['canopy']);
  assert.deepEqual(first.none, ['aerial']);
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'osm-way-77.json'), 'utf8'));
  assert.equal(saved.enrichment.aerial.status, 'none');
  assert.equal(saved.aerial, undefined);
  now += 30_000;
  const second = await enricher.schedule({ source: course.source, course });
  assert.deepEqual(second.skipped, ['canopy'], 'still cooling down');
  now += 60_000;
  await enricher.schedule({ source: course.source, course });
  assert.equal(canopyCalls, 2, 'retried after the cooldown');
});

test('a newer course cancels the older course scenery job', async () => {
  const cacheDir = tempDir('birdie-scenery-');
  const a = baseCourse();
  const b = baseCourse({ source: { courseId: 'osm:way:78', osmType: 'way', osmId: 78 } });
  let started;
  const startedA = new Promise((resolve) => { started = resolve; });
  const enricher = createSceneryEnricher({
    cacheDir,
    log: quiet,
    providers: {
      buildings: (course, { signal }) => new Promise((resolve, reject) => {
        if (course.source.osmId === 77) {
          started();
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        } else resolve({ status: 'ok', buildings: [] });
      }),
    },
  });
  const jobA = enricher.schedule({ source: a.source, course: a });
  await startedA;
  const jobB = enricher.schedule({ source: b.source, course: b });
  assert.equal(await jobA, null, 'A was cancelled');
  assert.deepEqual((await jobB).applied, ['buildings']);
  assert.equal(fs.existsSync(path.join(cacheDir, 'osm-way-77.json')), false, 'nothing saved for A');
  assert.deepEqual(enricher.pending(), []);
});

test('persistSceneryUpdate refuses foreign file names and stale cache versions', () => {
  const cacheDir = tempDir('birdie-scenery-');
  const course = baseCourse();
  assert.throws(() => persistSceneryUpdate({ cacheDir, course, artifacts: [{ file: '../x.jpg', bytes: Buffer.from('x') }] }), /invalid/);
  assert.throws(() => persistSceneryUpdate({ cacheDir, course, artifacts: [{ file: 'other.aerial.jpg', bytes: Buffer.from('x') }] }), /invalid/);
  assert.throws(() => persistSceneryUpdate({ cacheDir, course: { ...course, version: 3 } }), /current cache/);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('applySceneryUpdate copies only scenery onto the live course, and only in the same projection', () => {
  const live = baseCourse({ holes: [{ ref: 9 }] });
  const enriched = baseCourse({ buildings: [{ poly: [] }], canopy: { trees: [] }, aerial: { file: 'x' }, holes: [{ ref: 1 }] });
  assert.equal(applySceneryUpdate(live, enriched), true);
  assert.deepEqual(live.buildings, [{ poly: [] }]);
  assert.deepEqual(live.holes, [{ ref: 9 }], 'gameplay data untouched');
  const moved = baseCourse({ origin: { lat: 45.001, lon: -93 }, buildings: [] });
  assert.equal(applySceneryUpdate(live, moved), false);
});
