'use strict';
// How long the server takes over a shot, on this computer: the time between a launch
// monitor's message arriving and the shot being ready to broadcast (lib/game.js
// handleShot: flight, bounce and roll over the course), and the lineup's predictions
// (lib/predict.js). The frame rate is a separate matter: see docs/machines.md.
//
//   node tools/bench-shot.js                 the first cached course (BIRDIE_DATA_DIR),
//                                            or a built-in synthetic 18 holes when none
//   node tools/bench-shot.js --synthetic     always the synthetic course
//   node tools/bench-shot.js --json out.json also write the numbers as JSON
//
// Reads the course only; plays nothing in a running game and writes no game data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { Game } = require('../lib/game');
const { predictShot, predictCarries } = require('../lib/predict');
const { listCached, loadCached, makeSurfaceLookup } = require('../lib/course');

// Open Connect ball data for the shots timed (Speed mph, angles deg, spin rpm).
const SHOTS = {
  driver: { Speed: 150, VLA: 12, HLA: 1.5, TotalSpin: 2600, SpinAxis: -3 },
  '7-iron': { Speed: 118, VLA: 17.5, HLA: -1, TotalSpin: 6800, SpinAxis: 2 },
  wedge: { Speed: 78, VLA: 28, HLA: 0.5, TotalSpin: 9500, SpinAxis: 0 },
  chip: { Speed: 30, VLA: 20, HLA: 0, TotalSpin: 3000, SpinAxis: 0 },
};

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// A closed, slightly lumpy outline of n points around (cx, cy).
function blob(cx, cy, rx, ry, n) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const k = 1 + 0.15 * Math.sin(3 * a + cx) + 0.08 * Math.cos(5 * a + cy);
    return [cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k];
  });
}

// 18 holes with about as many polygons, vertices and trees as a mapped course: the
// surface lookup tests a point against every polygon, so their number is the load.
function syntheticCourse() {
  const rand = seeded(42);
  const surfaces = [], holes = [], trees = [];
  for (let h = 0; h < 18; h++) {
    const x = (h % 6) * 130, y0 = Math.floor(h / 6) * 470;
    const len = 330 + (h % 5) * 25;
    const tee = [x, y0], pin = [x + 10, y0 + len];
    holes.push({ ref: h + 1, par: 4, tee, pin, lengthYd: Math.round(len / 0.9144), line: [tee, [x + 5, y0 + len / 2], pin] });
    for (let t = 0; t < 4; t++) surfaces.push({ kind: 'tee', poly: blob(x + (t - 1.5) * 4, y0 - t * 9, 5, 4, 8) });
    surfaces.push({ kind: 'fairway', poly: blob(x + 5, y0 + len / 2 + 20, 20, len / 2 - 55, 90) });
    surfaces.push({ kind: 'green', poly: blob(pin[0], pin[1], 14, 12, 40) });
    for (let b = 0; b < 5; b++) {
      surfaces.push({ kind: 'bunker', poly: blob(x + (rand() - 0.5) * 60, y0 + 150 + rand() * (len - 150), 6 + rand() * 4, 4 + rand() * 3, 24) });
    }
    if (h % 3 === 0) surfaces.push({ kind: 'water', poly: blob(x - 45, y0 + 200, 18, 40, 50) });
    for (let t = 0; t < 170; t++) trees.push([x + (rand() < 0.5 ? -1 : 1) * (32 + rand() * 28), y0 + rand() * (len + 40)]);
  }
  const cellM = 10, nx = 105, ny = 170;
  const heights = Array.from({ length: nx * ny }, (_, k) => {
    const i = k % nx, j = (k - i) / nx;
    return +(3 * Math.sin(i / 9) + 2 * Math.cos(j / 13) + 0.6 * Math.sin((i + j) / 3)).toFixed(2);
  });
  return {
    name: 'Synthetic 18', surfaces, boundary: null, holes, trees, woods: [],
    elevation: { minX: -200, minY: -200, nx, ny, cellM, baseM: 250, heights },
  };
}

function pickCourse(synthetic) {
  if (!synthetic) {
    const cached = listCached();
    const course = cached.length ? loadCached(cached[0].file) : null;
    if (course) return { course, source: 'cached course' };
  }
  return { course: syntheticCourse(), source: 'synthetic course' };
}

// Median, 95th percentile and worst of fn's wall time (ms) over `runs`, after a warm-up.
function time(fn, runs) {
  for (let i = 0; i < 3; i++) fn(i);
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn(i + 3);
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const r2 = (v) => Math.round(v * 100) / 100;
  return { medianMs: r2(ms[ms.length >> 1]), p95Ms: r2(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]), maxMs: r2(ms[ms.length - 1]), runs };
}

function run({ synthetic = false, runs = 30, log = () => {} } = {}) {
  const { course, source } = pickCourse(synthetic);
  // the game narrates each shot on the console; keep the report readable
  const quiet = (fn) => (...args) => {
    const { log: l, warn: w } = console;
    console.log = console.warn = () => {};
    try { return fn(...args); } finally { console.log = l; console.warn = w; }
  };
  const game = new Game();
  quiet(() => game.setCourse(course))();
  if (!game.runtimeReady) game.activateRuntimeTerrain([]);

  const stages = {};
  const stage = (name, fn, n = runs) => {
    stages[name] = time(quiet(fn), n);
    log(name, stages[name]);
  };

  let sample = null;
  for (const [name, ball] of Object.entries(SHOTS)) {
    stage(`shot: ${name} from the tee`, (i) => {
      game.reset();
      const result = game.handleShot({ ...ball, HLA: ball.HLA + (i % 7) * 0.3 }, null);
      if (name === 'driver' && result) sample = result;
    });
  }
  // a putt of about 20 ft: from the green, on the tee's side of the pin
  stage('shot: 20 ft putt', (i) => {
    game.reset();
    const { tee, pin } = game.hole;
    const d = Math.hypot(pin[0] - tee[0], pin[1] - tee[1]) || 1;
    const back = 6 + (i % 5) * 0.2;
    game.ball = { x: pin[0] - (pin[0] - tee[0]) / d * back, y: pin[1] - (pin[1] - tee[1]) / d * back };
    game.lie = game.surfaceAt(game.ball.x, game.ball.y);
    game.handleShot({ Speed: 6.5 + (i % 3) * 0.2, VLA: 0, HLA: 2, TotalSpin: 0, SpinAxis: 0 }, 'PT');
  });
  stage('lineup: predict one club', (i) => { game.reset(); game.setAimOffset((i % 9) - 4); predictShot(game, {}); }, Math.min(runs, 20));
  stage('lineup: carries for the bag', () => { game.reset(); predictCarries(game); }, Math.min(runs, 10));

  // the polygon lookup the flight and roll ask for the surface under the ball
  const lookup = quiet(() => makeSurfaceLookup(course))();
  const rand = seeded(7);
  const xs = course.holes.flatMap((h) => [h.tee[0], h.pin[0]]), ys = course.holes.flatMap((h) => [h.tee[1], h.pin[1]]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const points = Array.from({ length: 20000 }, () => [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)]);
  const t0 = performance.now();
  for (const [x, y] of points) lookup(x, y);
  const surfaceLookupUs = Math.round((performance.now() - t0) / points.length * 1e4) / 10;

  return {
    machine: { cpu: (os.cpus()[0] || {}).model || 'unknown', cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.arch()}` },
    course: {
      source, name: course.name, holes: course.holes.length,
      surfaces: course.surfaces.length,
      vertices: course.surfaces.reduce((n, s) => n + s.poly.length, 0),
      trees: (course.trees || []).length,
    },
    stages,
    surfaceLookupUs,
    shotEventKb: sample ? Math.round(JSON.stringify(sample).length / 102.4) / 10 : null,
  };
}

function main(argv) {
  const jsonAt = argv.indexOf('--json');
  const report = run({ synthetic: argv.includes('--synthetic') });
  const { machine, course } = report;
  console.log(`${machine.cpu} (${machine.cores} threads), Node ${machine.node}, ${machine.platform}`);
  console.log(`${course.source}: ${course.name}, ${course.holes} holes, ${course.surfaces} surface polygons (${course.vertices} vertices), ${course.trees} trees\n`);
  console.log(`${'stage'.padEnd(34)}${'median'.padStart(10)}${'p95'.padStart(10)}${'worst'.padStart(10)}`);
  for (const [name, t] of Object.entries(report.stages)) {
    const ms = (v) => `${v.toFixed(2)} ms`.padStart(10);
    console.log(`${name.padEnd(34)}${ms(t.medianMs)}${ms(t.p95Ms)}${ms(t.maxMs)}`);
  }
  console.log(`\nsurface lookup: ${report.surfaceLookupUs} us a call; a driver's shot event: ${report.shotEventKb} KB`);
  if (jsonAt >= 0 && argv[jsonAt + 1]) {
    fs.writeFileSync(path.resolve(argv[jsonAt + 1]), JSON.stringify(report, null, 1) + '\n');
    console.log(`written to ${argv[jsonAt + 1]}`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { run, syntheticCourse, SHOTS };
