'use strict';
// Balls hit the course's real trees: lib/tree-obstacles.js indexes the trees the
// renderer draws, and simulateShot (opts.trees) bounces the ball off trunks and lets
// crowns swallow it. Deterministic per shot, invisible to shots no tree reaches, and
// cheap on a course with thousands of trees.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { simulateShot } = require('../lib/physics');
const { makeTerrain } = require('../lib/elevation');
const { Game } = require('../lib/game');
const {
  buildTreeObstacles, speciesAt, speciesForCrown, COURSE_DRY, TREE_MODELS,
} = require('../lib/tree-obstacles');

const fairway = () => 'fairway';
const ORIGIN = { x: 0, y: 0 };
const courseWith = ({ name = 'Test Course', canopy = [], trees = [], surfaces = [] } = {}) => ({
  name, surfaces, trees, ...(canopy.length ? { canopy: { trees: canopy } } : {}),
});
const obstacles = (canopy, trees = []) => buildTreeObstacles(courseWith({ canopy, trees }));
const treeHits = (r) => r.events.filter((e) => e.type === 'tree');

const PUNCH = { speedMph: 100, vla: 5, hla: 0, totalSpin: 3000, spinAxis: 0 };   // ~2 m up at 30 m
const I7 = { speedMph: 111, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0 };     // ~11 m up at 30 m
const DRIVER = { speedMph: 167, vla: 10.9, hla: 0, totalSpin: 2686, spinAxis: 0 };
const ROLL = { speedMph: 10, vla: 0, hla: 0, totalSpin: 0, spinAxis: 0 };        // rolls ~5 m

// ---------- the index ----------

test('no trees, no index; OSM points on a canopy tree or on mown ground are dropped', () => {
  assert.equal(buildTreeObstacles(courseWith()), null);
  assert.equal(buildTreeObstacles({ name: 'x', surfaces: [], canopy: { trees: [] }, trees: [] }), null);
  const fairwayPoly = { kind: 'fairway', poly: [[-20, 0], [20, 0], [20, 300], [-20, 300]] };
  const idx = buildTreeObstacles(courseWith({
    canopy: [[50, 50, 12, 4], [0, 100, 12, 4], [60, 80, 0, 3]],   // 2nd on the fairway, 3rd has no height
    trees: [[51, 51.5], [90, 90], [5, 150]],                       // a duplicate, a separate tree, one on the fairway
    surfaces: [fairwayPoly],
  }));
  assert.deepEqual([...idx.x].map((x, i) => [x, idx.y[i]]), [[50, 50], [90, 90]]);
  assert.ok(Math.abs(idx.trunkR[0] - (0.12 + 0.01 * 12)) < 1e-12, 'trunk radius 0.12 + 0.01 h');
  assert.ok(idx.crownR[0] >= 4, 'at least the measured crown');
});

test('a tree in a crowd or away from play gets the woods-grown model, as drawn', () => {
  const near = { line: [[0, 0], [0, 300]] }, away = { line: [[-200, 0], [-200, 300]] };
  const spot = [20, 150, 14, 5];
  const index = (canopy, hole) => buildTreeObstacles({ ...courseWith({ canopy }), holes: [hole] });
  assert.ok(index([spot], near).model[0] < 2, 'alone, 20 m off the line: open-grown');
  // three others within 7 m
  assert.equal(index([spot, [24, 150, 14, 5], [20, 154, 14, 5], [17, 147, 14, 5]], near).model[0], 2);
  // more than 60 m from every hole line
  assert.equal(index([spot], away).model[0], 2);
  // the woods form carries its crown higher
  const sp = TREE_MODELS[speciesForCrown(...spot)];
  const open = index([spot], near), woods = index([spot], away);
  assert.ok(Math.abs(open.base[0] - sp.models[open.model[0]][0] * 14) < 1e-9);
  assert.ok(Math.abs(woods.base[0] - sp.models[2][0] * 14) < 1e-9 && woods.base[0] > open.base[0]);
});

test('trees, species, models and sizes match what the renderer draws', async () => {
  const url = (p) => pathToFileURL(path.join(__dirname, '..', p)).href;
  const placement = await import(url('public/render/tree-placement.js'));
  const character = await import(url('public/render/course-character.js'));
  const gen = await import(url('public/render/tree-gen.js'));
  assert.deepEqual({ ...COURSE_DRY }, character.COURSE_DRY);
  assert.deepEqual(Object.keys(TREE_MODELS).sort(), [...placement.SPECIES].sort());
  // trees.js rules lib/tree-obstacles.js mirrors (its models, which one a tree gets, OSM size)
  const treesSrc = fs.readFileSync(path.join(__dirname, '..', 'public/render/trees.js'), 'utf8');
  for (const rule of [
    'generateTree(species, 1009 + v * 7 + species.length * 131, { forest: v === 2 })',
    'const WOODS_NEIGHBOURS = 3;',
    '(o.x - s.x) ** 2 + (o.y - s.y) ** 2 < 49',
    'c >= WOODS_NEIGHBOURS || s.edge === false ? 2 : (Math.abs(Math.floor(s.x * 7.13 + s.y * 3.71)) % 2)',
    '(s0.s || 1) * 0.85',
  ]) assert.ok(treesSrc.includes(rule), `trees.js no longer has "${rule}": bring lib/tree-obstacles.js in line`);
  // the crown table is measured from those models: leaf-mass bottom and top (3rd / 98th
  // percentile card extent) and the model's own crownR, / H
  const pct = (a, p) => a.slice().sort((u, v) => u - v)[Math.min(a.length - 1, Math.floor(p * a.length))];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  for (const [species, { H, models }] of Object.entries(TREE_MODELS)) {
    assert.equal(gen.TREE_SPECIES[species].H, H, species);
    models.forEach((row, v) => {
      const m = gen.generateTree(species, 1009 + v * 7 + species.length * 131, { forest: v === 2 });
      const half = (c) => Math.hypot(...c.up) * 0.5;
      const measured = [
        r3(Math.max(0, pct(m.cards.map((c) => c.p[1] - half(c)), 0.03)) / H),
        r3(pct(m.cards.map((c) => c.p[1] + half(c)), 0.98) / H),
        r3(m.crownR / H),
      ];
      assert.deepEqual(row, measured, `TREE_MODELS.${species}[${v}] is stale`);
    });
  }
  for (const dry of [0, 0.4, 0.85]) {
    for (let k = 0; k < 300; k++) {
      const x = k * 37.3 - 2000, y = k * 53.9 - 3000, h = 4 + (k % 30), r = 1 + (k % 9);
      assert.equal(speciesAt(x, y, dry, 0), placement.speciesAt(x, y, dry, 0));
      assert.equal(speciesForCrown(x, y, h, r, dry), placement.speciesForCrown(x, y, h, r, dry));
    }
  }
  // scene.js _treeSpots over the same course, uncapped
  const surfaces = [
    { kind: 'green', poly: [[0, 0], [30, 0], [30, 30], [0, 30]] },
    { kind: 'rough', poly: [[100, 100], [200, 100], [200, 200], [100, 200]] },  // trees may stand in rough
  ];
  const canopy = [], trees = [];
  for (let k = 0; k < 400; k++) {
    canopy.push([(k * 7.7) % 240 - 20, (k * 13.1) % 260 - 30, 4 + (k % 23), 0.5 + (k % 11) * 0.7]);
    trees.push([(k * 11.3) % 240 - 20, (k * 5.9) % 260 - 30]);
  }
  const blocking = ['fairway', 'green', 'tee', 'bunker', 'water'];
  const blocked = (x, y) => surfaces.some((s) => blocking.includes(s.kind) && placement.pointInPoly(x, y, s.poly));
  for (const name of ['Test Course', 'Chambers Bay']) {
    const course = courseWith({ name, canopy, trees, surfaces });
    const spots = placement.placeCourseTrees({
      trees, canopy, holeLines: [], cap: Infinity, courseDry: character.courseDryFor(name), blocked,
    });
    const idx = buildTreeObstacles(course);
    assert.equal(idx.count, spots.length);
    for (let i = 0; i < idx.count; i++) {
      // the same tree, drawn as realTreeSize sizes it (an OSM tree: the model x its size draw)
      const p = spots.find((s) => s.x === idx.x[i] && s.y === idx.y[i]);
      assert.ok(p, `${idx.x[i]},${idx.y[i]} is drawn`);
      const { H, models } = TREE_MODELS[p.species];
      const [base, , rK] = models[idx.model[i]];
      const { w, ht } = p.h ? placement.realTreeSize(p, H, rK * H, 0.5, 0.5) : { w: 0.85 * p.s, ht: 0.85 * p.s * 1.03 };
      const near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
      assert.ok(near(idx.trunkR[i], 0.12 + 0.01 * H * ht), 'height');
      assert.ok(near(idx.crownR[i], rK * H * w), 'crown radius');
      assert.ok(near(idx.base[i], base * H * ht), 'crown base');
    }
  }
});

// ---------- trunks ----------

test('a low shot into a trunk is knocked back toward the tee', () => {
  const free = simulateShot(PUNCH, ORIGIN, 0, fairway);
  const r = simulateShot(PUNCH, ORIGIN, 0, fairway, { trees: obstacles([[0.1, 30, 14, 5]]) });
  assert.ok(free.totalYd > 80, `without the tree it runs out to ${free.totalYd.toFixed(0)} yd`);
  const hits = treeHits(r);
  assert.equal(hits.length, 1);
  const [hit] = hits;
  assert.equal(hit.part, 'trunk');
  assert.ok(Math.abs(hit.y - 30) < 0.5 && hit.z > 1 && hit.z < 3, `hit at ${hit.x}, ${hit.y}, ${hit.z}`);
  assert.ok(r.end.y < 30, `bounced back, ended at y=${r.end.y.toFixed(1)}`);
  // the replay gets a trajectory sample exactly at the hit
  assert.ok(r.points.some((p) => p.t === hit.t && p.x === hit.x && p.y === hit.y && p.z === hit.z));
});

test('a ball rolling into a trunk bounces back off it', () => {
  const free = simulateShot(ROLL, ORIGIN, 0, fairway, { putt: true });
  const trees = obstacles([[0, 3, 12, 4]]);
  const r = simulateShot(ROLL, ORIGIN, 0, fairway, { putt: true, trees });
  assert.ok(free.end.y > 4.5, 'without the tree it rolls past');
  const [hit] = treeHits(r);
  assert.equal(hit.part, 'trunk');
  assert.ok(r.end.y < hit.y - 0.3, `rolled back off the bark to y=${r.end.y.toFixed(2)}`);
  assert.ok(Math.hypot(r.end.x, r.end.y - 3) > trees.trunkR[0], 'never ends inside the trunk');
});

test('trunks stand on the terrain the shot is played over', () => {
  const trees = obstacles([[0.1, 30, 14, 5]]);
  const raised = { h: () => 10, grad: () => ({ dx: 0, dy: 0 }) };
  const low = treeHits(simulateShot(PUNCH, ORIGIN, 0, fairway, { trees }))[0];
  const high = treeHits(simulateShot(PUNCH, ORIGIN, 0, fairway, { trees, terrain: raised }))[0];
  assert.equal(low.part, 'trunk');
  assert.equal(high.part, 'trunk');
  assert.ok(Math.abs(high.z - low.z - 10) < 1e-6, `${high.z} vs ${low.z} + 10`);
});

// ---------- crowns ----------

test('a shot into a crown is usually stopped and drops near the tree', () => {
  const free = simulateShot(I7, ORIGIN, 0, fairway);
  // a 20 m oak, crown ~8-20 m up, 7 m wide, 34 m out: the 7-iron climbs through it
  const trees = obstacles([[0, 34, 20, 7]]);
  let stopped = 0;
  for (let k = 0; k < 20; k++) {
    const r = simulateShot({ ...I7, speedMph: I7.speedMph + k * 0.05 }, ORIGIN, 0, fairway, { trees });
    const caught = treeHits(r).some((e) => e.part === 'crown');
    if (caught && r.totalYd < free.totalYd / 2 && Math.hypot(r.end.x, r.end.y - 34) < 40) stopped++;
  }
  assert.ok(stopped >= 16, `${stopped}/20 caught by the crown (free flight ${free.totalYd.toFixed(0)} yd)`);
});

test('a shot flying well above a tree is untouched', () => {
  const free = simulateShot(DRIVER, ORIGIN, 0, fairway);
  // the drive is ~25 m up at 120 m; this tree tops out at 10 m
  assert.deepEqual(simulateShot(DRIVER, ORIGIN, 0, fairway, { trees: obstacles([[0, 120, 10, 4]]) }), free);
});

test("a fir whose skirt is drawn down to the ground catches a rolling ball", () => {
  // a narrow 16 m crown is a conifer; find one drawn as a fir with boughs on the ground
  const fx = Array.from({ length: 200 }, (_, k) => k * 7).find((x) => {
    const idx = obstacles([[x, 20, 16, 2.5]]);
    return idx.cone[0] === 1 && idx.base[0] === 0;
  });
  assert.ok(fx !== undefined, 'no fir model reaches the ground');
  const trees = obstacles([[fx, 20, 16, 2.5]]);
  let caught = 0;
  for (let k = 0; k < 20; k++) {
    const roll = { ...ROLL, speedMph: 16 + k * 0.1 };
    const start = { x: fx + 1.2, y: 10 };   // aimed past the trunk, into the boughs
    const free = simulateShot(roll, start, 0, fairway, { putt: true });
    const r = simulateShot(roll, start, 0, fairway, { putt: true, trees });
    if (r.totalYd < free.totalYd - 1 && treeHits(r).some((e) => e.part === 'crown')) caught++;
  }
  assert.ok(caught >= 12, `${caught}/20 caught`);
});

// ---------- determinism, no-tree parity, speed ----------

test('the same shot always plays out the same way', () => {
  const trees = obstacles([[0, 34, 20, 7]]);
  const a = simulateShot(I7, ORIGIN, 0, fairway, { trees });
  assert.ok(treeHits(a).length > 0);
  assert.deepEqual(simulateShot(I7, ORIGIN, 0, fairway, { trees }), a);
  assert.deepEqual(simulateShot(I7, ORIGIN, 0, fairway, { trees: obstacles([[0, 34, 20, 7]]) }), a);
  // the dice come from the shot itself: different swings rattle through differently
  const ends = new Set();
  for (let k = 0; k < 10; k++) {
    const r = simulateShot({ ...I7, hla: k * 0.01 }, ORIGIN, 0, fairway, { trees });
    ends.add(`${r.end.x.toFixed(2)},${r.end.y.toFixed(2)}`);
  }
  assert.ok(ends.size >= 6, `only ${ends.size} distinct outcomes`);
});

test('with no tree in reach, results are bit-for-bit the pre-tree physics', () => {
  const grid = (minX, minY, cellM, n, f) => {
    const heights = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights.push(f(i, j));
    return makeTerrain({ minX, minY, cellM, nx: n, ny: n, heights }, [], { smooth: true });
  };
  const hills = grid(-200, -20, 10, 41, (i, j) => 3 * Math.sin(i * 0.4) * Math.cos(j * 0.3) + j * 0.08);
  const tilted = grid(-20, 130, 4, 11, (i, j) => 0.08 * j - 0.04 * i);   // 2% up north, 1% down east
  const holeAt = (x, y) => (Math.hypot(x, y - 150) < 14 ? 'green' : Math.abs(x) < 22 ? 'fairway' : 'rough');
  const PIN = { x: 0, y: 150 };
  const shots = {
    driver: (o) => simulateShot(DRIVER, ORIGIN, 0, fairway, o),
    approach: (o) => simulateShot({ speedMph: 120, vla: 16.3, hla: -2, totalSpin: 7097, spinAxis: -6 }, ORIGIN, 1.5, holeAt,
      { terrain: hills, wind: { speedMps: 4, fromDeg: 30 }, pin: PIN, ...o }),
    putt: (o) => simulateShot({ speedMph: 7.5, vla: 0.5, hla: -1.5, totalSpin: 100, spinAxis: 0 }, { x: 1, y: 143 }, -8.1,
      () => 'green', { terrain: tilted, pin: PIN, ...o }),
  };
  // lib/physics.js before trees existed (3987710), on these exact shots. If you change
  // the ball physics on purpose, re-capture them.
  const PRE_TREE = {
    driver: { carryYd: 278.8034728268049, totalYd: 300.7181164971988, offlineYd: 0, apexFt: 101.1233303172129,
      flightTime: 6.887999999999463, end: { x: 0, y: 274.9766457250386 }, endZ: 0, points: 498,
      events: ['bounce:fairway', 'bounce:fairway', 'bounce:fairway', 'bounce:fairway'], holed: false },
    approach: { carryYd: 152.8617437319289, totalYd: 159.66087628630024, offlineYd: -25.67724036637689,
      apexFt: 101.32512484100496, flightTime: 6.393999999999518, end: { x: -19.69929404238118, y: 144.65876465678048 },
      endZ: 1.8513228339279901, points: 449,
      events: ['bounce:fairway', 'bounce:fairway', 'bounce:fairway', 'bounce:fairway'], holed: false },
    putt: { carryYd: 7.733013792503801, totalYd: 7.733013792503801, offlineYd: -0.004062810754023478, apexFt: 0,
      flightTime: 3.1599999999998736, end: { x: 0, y: 150 }, endZ: 0.19537508403643467, points: 159,
      events: ['holed'], holed: true },
  };
  const summary = (r) => JSON.parse(JSON.stringify({
    carryYd: r.carryYd, totalYd: r.totalYd, offlineYd: r.offlineYd, apexFt: r.apexFt,
    flightTime: r.flightTime, end: r.end, endZ: r.endZ, points: r.points.length,
    events: r.events.map((e) => (e.surface ? `${e.type}:${e.surface}` : e.type)), holed: r.holed,
  }));
  // trees well away from every shot, on a course with OSM points as well
  const far = [];
  for (let k = 0; k < 2000; k++) far.push([300 + (k % 50) * 9, -200 + Math.floor(k / 50) * 13, 6 + (k % 9) * 2, 2 + (k % 5)]);
  const farTrees = buildTreeObstacles(courseWith({ canopy: far, trees: [[-500, 100], [-520, 140]] }));
  for (const [name, play] of Object.entries(shots)) {
    const base = play({});
    assert.deepEqual(summary(base), PRE_TREE[name], name);
    for (const trees of [null, undefined, buildTreeObstacles(courseWith()), farTrees]) {
      assert.deepEqual(play({ trees }), base, `${name} with ${trees ? `${trees.count} far trees` : trees}`);
    }
  }
});

test('10k trees: built once in milliseconds, shots stay within a few ms', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const canopy = [];
  for (let k = 0; k < 10000; k++) canopy.push([-1000 + rnd() * 2000, -300 + rnd() * 2000, 5 + rnd() * 20, 1.5 + rnd() * 6]);
  let t0 = performance.now();
  const trees = buildTreeObstacles(courseWith({ canopy }));
  const buildMs = performance.now() - t0;
  assert.equal(trees.count, 10000);
  assert.ok(buildMs < 1000, `index built in ${buildMs.toFixed(0)} ms`);

  const launches = [DRIVER, I7, PUNCH, { speedMph: 91, vla: 25.5, hla: 0, totalSpin: 9300, spinAxis: 0 }];
  const shots = [];
  for (const l of launches) for (let a = -40; a <= 40; a += 10) shots.push([l, a]);
  const play = (o) => { for (const [l, aim] of shots) simulateShot(l, ORIGIN, aim, fairway, o); };
  const best = (o) => {
    play(o);   // warm up
    let ms = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      t0 = performance.now();
      play(o);
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms / shots.length;
  };
  const without = best({});
  const withTrees = best({ trees });
  assert.ok(withTrees - without < 3, `per shot: ${withTrees.toFixed(2)} ms with trees vs ${without.toFixed(2)} ms without`);
});

// ---------- the game ----------

test('Game indexes the course trees once and plays shots through them', () => {
  const hole = { par: 4, tee: [0, 0], pin: [0, 300], lengthYd: 330, line: [[0, 0], [0, 300]] };
  const g = new Game();
  g.setCourse({ ...courseWith({ canopy: [[0.1, 30, 14, 5]], trees: [[200, 200]] }), boundary: null, elevation: null, holes: [hole] });
  assert.equal(g.treeObstacles.count, 2);
  const r = g.handleShot({ Speed: PUNCH.speedMph, VLA: PUNCH.vla, HLA: 0, TotalSpin: PUNCH.totalSpin, SpinAxis: 0 });
  assert.equal(treeHits(r.sim)[0].part, 'trunk');
  assert.ok(r.end.y < 30);

  const prepared = g.prepareCourse({ ...courseWith(), boundary: null, elevation: null, holes: [hole] });
  assert.equal(prepared.treeObstacles, null);
  g.commitPreparedCourse(prepared);
  assert.equal(g.treeObstacles, null);
});
