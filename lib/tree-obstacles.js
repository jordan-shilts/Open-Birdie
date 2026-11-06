'use strict';
// Real trees as ball obstacles. One index per course (Game.prepareCourse) over the
// trees the renderer draws: canopy trees (course.canopy.trees, [x, y, heightM,
// crownRadiusM]) plus OSM tree points (course.trees) with no canopy tree within 3 m,
// placed, filtered and sized as public/render/tree-placement.js placeCourseTrees and
// public/render/trees.js do. The renderer's woods fill and horizon band are guesses
// at where trees stand, not real trees, so they are not obstacles.
//
// Each tree is a trunk — a vertical cylinder from the ground to the crown base,
// radius 0.12 + 0.01 h — and a crown fitted to the model the renderer draws there
// (public/render/tree-gen.js: per species an open-grown or a woods-grown form): an
// ellipsoid around the leaf mass, or for firs a cone that comes down to the ground.
// A uniform 8 m grid lists, per cell, every tree whose crown reaches into it, so a
// ball position finds its candidate trees with a single Map lookup.
//
// treeContacts() is the per-shot collision state simulateShot steps through. Trunks
// are solid: the ball bounces off the bark. Crowns are porous: every metre inside one
// has a chance of meeting a branch, which takes most of the ball's speed and spin and
// throws it down and back, so a ball that flies into a tree usually drops out under
// it. The dice are a PRNG seeded from the shot itself, so the same shot always ends
// in the same place.

const { pointInPoly } = require('./course');

const BALL_R = 0.02135;      // m, lib/physics.js R
const CELL_M = 8;            // grid pitch
const CELL_SPAN = 16384;     // cells each way from the origin (+-131 km): keys stay small ints
const REACH_PAD_M = 1;       // > one 2 ms step at any ball speed, so a step's path stays in its cell's list
const DEDUPE_M = 3;          // an OSM point this close to a canopy tree is that tree (placeRealTrees)
const NEAR_PLAY_M = 60;      // trees this close to a hole line are near play (tree-placement.js)
const CROWD_M = 7;           // trees.js: WOODS_NEIGHBOURS others this close make a woods-grown tree
const WOODS_NEIGHBOURS = 3;
const OSM_SCALE = 0.85;      // trees.js draws an OSM tree at 0.85 x its size draw
const TRUNK_MIN_M = 1;       // the bottom metre of every trunk is solid, even inside a fir's skirt
const CONE_EXP = 0.6;        // fir crown radius ~ (1 - u)^0.6 from its bottom (u = 0) to the tip (u = 1)
const BLOCKING_KINDS = ['fairway', 'green', 'tee', 'bunker', 'water']; // no trees drawn here (scene.js _treeSpots)
const PAR3_CLEAR_M = 3;      // par3LineBlock: a crown this close to a par 3's tee-to-pin line
const OSM_CROWN_M = 3;       // the crown a point tree (no measured crown) is taken to have

// Trunk: normal rebound and the share of the other velocity components the bark leaves.
const TRUNK_E_MIN = 0.4, TRUNK_E_MAX = 0.5;
const TRUNK_GRIP = 0.85;
const TRUNK_SPIN_KEEP = 0.3;
// Crown branch hit: speed kept, and the new heading = old heading + CROWN_SCATTER x a
// random unit vector, pulled CROWN_BACK against the horizontal travel and CROWN_DOWN down.
const CROWN_KEEP_MIN = 0.2, CROWN_KEEP_MAX = 0.6;
const CROWN_SCATTER = 1.2;
const CROWN_BACK = 0.35;
const CROWN_DOWN = 0.45;
const CROWN_SPIN_KEEP = 0.3;
// A contact slower than this (m/s into the trunk, or ball speed for a crown on the
// ground) just slows or slides the ball — no rebound, no event — so a ball dribbling
// against a tree on a slope settles quietly.
const QUIET_MPS = 0.5;

// The renderer's tree models, measured: trees.js draws three per species (tree-gen.js
// generateTree): [0] and [1] open-grown, [2] grown in closed woods. H = model height
// (m); each model is [base, top, rK]: its leaf mass's bottom and top above the ground,
// and its crown radius (the model's crownR), as fractions of H. density = branch hits
// per metre travelled inside the crown. test/tree-collision.test.js regenerates these.
const TREE_MODELS = Object.freeze({
  oak:   Object.freeze({ H: 16, cone: false, density: 0.35, models: [[0.324, 0.923, 0.54], [0.34, 0.987, 0.593], [0.512, 0.957, 0.417]] }),
  maple: Object.freeze({ H: 17, cone: false, density: 0.35, models: [[0.309, 0.955, 0.387], [0.305, 0.972, 0.396], [0.469, 1.032, 0.307]] }),
  birch: Object.freeze({ H: 15, cone: false, density: 0.25, models: [[0.438, 0.989, 0.257], [0.432, 0.988, 0.283], [0.553, 1.001, 0.227]] }),
  pine:  Object.freeze({ H: 22, cone: false, density: 0.3, models: [[0.581, 1.017, 0.308], [0.614, 1.004, 0.279], [0.686, 1.002, 0.205]] }),
  fir:   Object.freeze({ H: 17, cone: true, density: 0.4, models: [[0.01, 0.945, 0.229], [0, 0.934, 0.223], [0.167, 0.951, 0.198]] }),
});

// ---------------------------------------------------------------- renderer parity
// Ports of the renderer's species and model choice, so each obstacle has the crown
// the player sees. test/tree-collision.test.js checks them against the originals.

// public/render/course-character.js COURSE_DRY: links courses lean to pines. Keyed by
// the course's own name, the part of `name` before its first comma.
const COURSE_DRY = Object.freeze({
  'Chambers Bay': 0.85,
  'TPC Sawgrass': 0.0,
  'St Andrews Old Course': 0.7,
  'Bandon Dunes Golf Resort': 0.8,
  'Whistling Straits': 0.75,
  // added with the courses built 2026-11-04: links and sandy seaside courses lean tan,
  // desert target golf half way (green corridors, desert round them), parkland lush
  'Torrey Pines Golf Course (South)': 0.3,
  'TPC Scottsdale (Stadium Course)': 0.5,
  'Kiawah Island Golf Resort (Ocean Course)': 0.55,
  'Augusta National Golf Club': 0.0,
  'Shinnecock Hills Golf Club': 0.75,
  'Oakmont Country Club': 0.1,
  'Harbour Town Golf Links': 0.0,
  'Spyglass Hill Golf Course': 0.25,
});
const courseKey = (name) => String(name ?? '').split(',')[0].trim().toLowerCase();
const DRY_BY_KEY = new Map(Object.entries(COURSE_DRY).map(([k, v]) => [courseKey(k), v]));
function courseDryFor(name) {
  const v = DRY_BY_KEY.get(courseKey(name));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

// public/render/course-character.js COURSE_FLORA: species weights [oak, pine, fir,
// birch, maple] for courses whose trees are part of the place.
const COURSE_FLORA = Object.freeze({
  'Augusta National Golf Club': [0.24, 0.68, 0, 0, 0.08],
  'Augusta National Par 3 Course': [0.24, 0.68, 0, 0, 0.08],
  'Harbour Town Golf Links': [0.62, 0.38, 0, 0, 0],
  'Kiawah Island Golf Resort (Ocean Course)': [0.55, 0.45, 0, 0, 0],
  'Spyglass Hill Golf Course': [0.2, 0.8, 0, 0, 0],
  'Torrey Pines Golf Course (South)': [0.3, 0.7, 0, 0, 0],
  'TPC Scottsdale (Stadium Course)': [0.8, 0.2, 0, 0, 0],
  'TPC Sawgrass': [0.45, 0.55, 0, 0, 0],
  'Oakmont Country Club': [0.5, 0.15, 0.05, 0, 0.3],
  'Shinnecock Hills Golf Club': [0.55, 0.4, 0, 0, 0.05],
});
const FLORA_BY_KEY = new Map(Object.entries(COURSE_FLORA).map(([k, v]) => [courseKey(k), v]));
function floraFor(name) {
  return FLORA_BY_KEY.get(courseKey(name)) || null;
}

// public/render/tree-placement.js canopyHeight: the canopy map runs low on tall trees.
const CANOPY_TALL_STRETCH = 0.35;
function canopyHeight(h) {
  return h > 8 ? 8 + (h - 8) * (1 + CANOPY_TALL_STRETCH) : h;
}

const SPECIES = ['oak', 'pine', 'fir', 'birch', 'maple'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// tree-placement.js speciesAt: the species stand at a spot.
function speciesAt(x, y, courseDry = 0, salt = 0, flora = null) {
  const n = vnoise(x * 0.011 + 3.3, y * 0.011 - 1.7);
  const j = hash2(x * 0.37 + salt, y * 0.41 - salt) * 0.14 - 0.07;
  const v = Math.min(0.999, Math.max(0, n + j));
  if (flora) {
    const tot = flora.reduce((a, b) => a + b, 0) || 1;
    let acc = 0, last = SPECIES[0];
    for (let k = 0; k < SPECIES.length; k++) {
      if (!(flora[k] > 0)) continue;
      acc += flora[k] / tot; last = SPECIES[k];
      if (v < acc) return SPECIES[k];
    }
    return last;
  }
  const dry = Math.min(1, Math.max(0, courseDry));
  const lush = [0.32, 0.16, 0.22, 0.06, 0.24];
  const links = [0.2, 0.44, 0.14, 0.14, 0.08];
  let acc = 0;
  for (let k = 0; k < SPECIES.length; k++) {
    acc += lush[k] + (links[k] - lush[k]) * dry;
    if (v < acc) return SPECIES[k];
  }
  return SPECIES[SPECIES.length - 1];
}

// tree-placement.js speciesForCrown: narrow measured crowns are conifers.
function speciesForCrown(x, y, h, r, courseDry = 0, flora = null) {
  const ratio = r / Math.max(1, h);
  const stand = speciesAt(x, y, courseDry, 0, flora);
  if (flora) {
    if (ratio < 0.18 && stand !== 'pine' && stand !== 'fir' && (flora[1] > 0 || flora[2] > 0)) return flora[1] >= flora[2] ? 'pine' : 'fir';
    return stand;
  }
  if (ratio < 0.22) return courseDry > 0.5 || stand === 'pine' ? 'pine' : 'fir';
  if (ratio < 0.3) return stand === 'pine' || stand === 'fir' || stand === 'maple' ? stand : 'oak';
  return stand === 'birch' || stand === 'maple' ? stand : 'oak';
}

// trees.js: the woods-grown model for a tree in a crowd (WOODS_NEIGHBOURS others
// within CROWD_M) or away from play, else one of the two open-grown forms.
function modelIndex(p, crowd) {
  return crowd >= WOODS_NEIGHBOURS || !p.edge ? 2 : Math.abs(Math.floor(p.x * 7.13 + p.y * 3.71)) % 2;
}

// trees.js crowdedness: how many other trees stand within CROWD_M of each.
function crowdedness(spots) {
  const grid = new Map(), key = (cx, cy) => `${cx},${cy}`;
  spots.forEach((s, i) => {
    const k = key(Math.floor(s.x / CROWD_M), Math.floor(s.y / CROWD_M));
    if (grid.has(k)) grid.get(k).push(i); else grid.set(k, [i]);
  });
  return spots.map((s) => {
    let n = 0;
    const cx = Math.floor(s.x / CROWD_M), cy = Math.floor(s.y / CROWD_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) || []) {
          const o = spots[j];
          if (o !== s && (o.x - s.x) ** 2 + (o.y - s.y) ** 2 < CROWD_M * CROWD_M) n++;
        }
      }
    }
    return n;
  });
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---------------------------------------------------------------- the index

// No tree is drawn on mown ground, sand or water (scene.js _treeSpots `blocked`).
function blockedGround(surfaces) {
  const polys = [];
  for (const s of surfaces || []) {
    if (!s || !BLOCKING_KINDS.includes(s.kind) || !Array.isArray(s.poly) || s.poly.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of s.poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    polys.push({ poly: s.poly, minX, minY, maxX, maxY });
  }
  return (x, y) => {
    for (const b of polys) if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInPoly(x, y, b.poly)) return true;
    return false;
  };
}

// A par 3's shot is the line from the tee to the pin, and no tree stands in it: a tree
// whose crown comes within PAR3_CLEAR_M of that line is not drawn and not an obstacle
// (public/render/tree-placement.js par3LineBlock and lib/tree-obstacles.js, kept the
// same by a test). Canopy data can predate a hole: Augusta's Par 3 Course re-routed
// holes 1-5 in 2023, and a tree stood a few metres in front of the 4th tee, stopping
// every wedge. Fairways already keep trees off longer holes' lines.
function par3LineBlock(holes) {
  const lines = (holes || []).filter((h) => h && h.par === 3 && Array.isArray(h.tee) && Array.isArray(h.pin))
    .map((h) => [h.tee[0], h.tee[1], h.pin[0], h.pin[1]]);
  return (x, y, r = OSM_CROWN_M) => {
    const reach = PAR3_CLEAR_M + (r > 0 ? r : OSM_CROWN_M);
    for (const [ax, ay, bx, by] of lines) if (distToSegment(x, y, ax, ay, bx, by) < reach) return true;
    return false;
  };
}

// A placed tree's size and crown as drawn with its model. A canopy tree stands at
// its measured height h with its crown radius r held within the band trees.js
// realTreeSize allows the model; an OSM point is the model at the renderer's size draw
// s (height x 0.85 s x 0.88-1.18, width x 0.85 s x 0.85-1.15; the means are used).
function sized(p, crowd) {
  const sp = TREE_MODELS[p.species];
  const model = modelIndex(p, crowd);
  const [base, top, rK] = sp.models[model];
  let h, crownR;
  if (p.h) {
    h = p.h;
    const k = rK * h;
    crownR = p.r > 0 ? Math.min(1.6 * k, Math.max(0.55 * k, p.r)) : k;
  } else {
    const s = OSM_SCALE * p.s;
    h = sp.H * s * 1.03;
    crownR = rK * sp.H * s;
  }
  return { x: p.x, y: p.y, h, crownR, base: base * h, top: top * h, cone: sp.cone, density: sp.density, model };
}

const cellOf = (v) => Math.floor(v / CELL_M);
const cellKey = (cx, cy) => (cx + CELL_SPAN) * (2 * CELL_SPAN) + (cy + CELL_SPAN);
const inGrid = (cx, cy) => cx >= -CELL_SPAN && cx < CELL_SPAN && cy >= -CELL_SPAN && cy < CELL_SPAN;

class TreeObstacles {
  constructor(spots) {
    const n = spots.length;
    this.count = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.trunkR = new Float64Array(n);    // m
    this.trunkTop = new Float64Array(n);  // solid trunk height above the ground (m)
    this.base = new Float64Array(n);      // crown bottom above the ground (m)
    this.span = new Float64Array(n);      // crown bottom to top (m)
    this.crownR = new Float64Array(n);    // widest crown radius (m)
    this.cone = new Uint8Array(n);        // 1 = fir cone, 0 = ellipsoid
    this.density = new Float64Array(n);   // branch hits per metre inside the crown
    this.model = new Uint8Array(n);       // which of its species' TREE_MODELS the renderer draws
    this.cells = new Map();               // cell key -> indices of the trees reaching into it
    spots.forEach((p, i) => {
      this.x[i] = p.x;
      this.y[i] = p.y;
      this.trunkR[i] = 0.12 + 0.01 * p.h;
      this.base[i] = p.base;
      this.span[i] = p.top - p.base;
      this.trunkTop[i] = Math.max(p.base, TRUNK_MIN_M);
      this.crownR[i] = p.crownR;
      this.cone[i] = p.cone ? 1 : 0;
      this.density[i] = p.density;
      this.model[i] = p.model;
      const reach = Math.max(p.crownR, this.trunkR[i] + BALL_R) + REACH_PAD_M;
      for (let cy = cellOf(p.y - reach); cy <= cellOf(p.y + reach); cy++) {
        for (let cx = cellOf(p.x - reach); cx <= cellOf(p.x + reach); cx++) {
          if (!inGrid(cx, cy)) continue;
          const key = cellKey(cx, cy);
          const list = this.cells.get(key);
          if (list) list.push(i); else this.cells.set(key, [i]);
        }
      }
    });
    this._ground = new WeakMap(); // terrain sampler -> each trunk's ground height (NaN = not sampled yet)
  }

  // Trees whose crown or trunk reaches the grid cell holding (x, y).
  near(x, y) {
    const cx = cellOf(x), cy = cellOf(y);
    return (inGrid(cx, cy) && this.cells.get(cellKey(cx, cy))) || EMPTY;
  }

  // Ground heights under the trunks for one terrain sampler, filled in lazily: the
  // terrain can be rebuilt after the course loads (HD activation), the trees cannot.
  groundFor(terrain) {
    let g = this._ground.get(terrain);
    if (!g) { g = new Float64Array(this.count).fill(NaN); this._ground.set(terrain, g); }
    return g;
  }
}
const EMPTY = Object.freeze([]);

/**
 * Obstacle index for a course's real trees, or null when it has none.
 * @param {object} course {name, surfaces, canopy: {trees}, trees}
 */
function buildTreeObstacles(course) {
  const canopy = Array.isArray(course?.canopy?.trees) ? course.canopy.trees : [];
  const osm = Array.isArray(course?.trees) ? course.trees : [];
  if (!canopy.length && !osm.length) return null;
  const dry = courseDryFor(course.name);
  const flora = floraFor(course.name);
  const finite = (...v) => v.every(Number.isFinite);
  const spots = [];   // as placeCourseTrees returns them: {x, y, species, edge, h, r} | {x, y, species, edge, s}
  // the renderer's OSM size draws: one per OSM tree it keeps, in order (placeCourseTrees)
  const rnd = mulberry32(1234);
  if (canopy.length) {
    const onGround = blockedGround(course.surfaces);
    const onPar3Line = par3LineBlock(course.holes);
    const blocked = (x, y, r) => onGround(x, y) || onPar3Line(x, y, r);
    const near = new Map();   // DEDUPE_M grid of the canopy trees
    const nearKey = (x, y) => `${Math.floor(x / DEDUPE_M)},${Math.floor(y / DEDUPE_M)}`;
    for (const t of canopy) {
      if (!Array.isArray(t)) continue;
      const [x, y, h0, r] = t;
      if (!(h0 > 0) || blocked(x, y, r) || !finite(x, y, h0)) continue;
      const h = canopyHeight(h0);
      spots.push({ x, y, h, r, species: speciesForCrown(x, y, h, r, dry, flora) });
      const k = nearKey(x, y);
      if (near.has(k)) near.get(k).push(t); else near.set(k, [t]);
    }
    const nearCanopy = (x, y) => {
      const cx = Math.floor(x / DEDUPE_M), cy = Math.floor(y / DEDUPE_M);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const t of near.get(`${cx + dx},${cy + dy}`) || []) if (Math.hypot(t[0] - x, t[1] - y) < DEDUPE_M) return true;
        }
      }
      return false;
    };
    for (const p of osm) {
      if (!Array.isArray(p)) continue;
      const [x, y] = p;
      if (nearCanopy(x, y) || blocked(x, y)) continue;
      const s = 0.85 + rnd() * 0.5;
      if (finite(x, y)) spots.push({ x, y, s, species: speciesAt(x, y, dry, 0, flora) });
    }
    // near play: within NEAR_PLAY_M of a hole line (every tree when there are none)
    const lines = (course.holes || []).map((h) => h && h.line).filter(Array.isArray);
    const lineDist = (x, y) => {
      let d = Infinity;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) d = Math.min(d, distToSegment(x, y, line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
      }
      return d;
    };
    for (const p of spots) p.edge = !lines.length || lineDist(p.x, p.y) <= NEAR_PLAY_M;
  } else {
    // no canopy: the renderer draws every OSM tree as it is
    for (const p of osm) {
      if (!Array.isArray(p)) continue;
      const [x, y] = p;
      const s = 0.85 + rnd() * 0.5;
      if (finite(x, y)) spots.push({ x, y, s, species: speciesAt(x, y, dry, 0, flora), edge: true });
    }
  }
  if (!spots.length) return null;
  const crowd = crowdedness(spots);
  return new TreeObstacles(spots.map((p, i) => sized(p, crowd[i])));
}

// ---------------------------------------------------------------- per-shot contacts

const SEED_F64 = new Float64Array(8);
const SEED_U32 = new Uint32Array(SEED_F64.buffer);

// 32-bit seed from everything that defines a shot: launch, start spot and aim.
function shotSeed(launch, start, aimDeg) {
  SEED_F64[0] = launch.speedMph || 0; SEED_F64[1] = launch.vla || 0; SEED_F64[2] = launch.hla || 0;
  SEED_F64[3] = launch.totalSpin || 0; SEED_F64[4] = launch.spinAxis || 0;
  SEED_F64[5] = start.x || 0; SEED_F64[6] = start.y || 0; SEED_F64[7] = aimDeg || 0;
  let h = 0x811c9dc5;                                    // FNV-1a over the IEEE-754 words
  for (let i = 0; i < SEED_U32.length; i++) h = Math.imul(h ^ SEED_U32[i], 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);           // murmur3 finaliser
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Earliest fraction s in [0, 1] of the 2D step (x0, y0) -> (x1, y1) at which it touches
// the circle (cx, cy, rad); 0 when it starts inside; -1 when it misses.
function sweepCircle(x0, y0, x1, y1, cx, cy, rad) {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - rad * rad;
  if (c <= 0) return 0;
  const dx = x1 - x0, dy = y1 - y0;
  const b = fx * dx + fy * dy;
  if (b >= 0) return -1;                  // heading away
  const a = dx * dx + dy * dy;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const s = (-b - Math.sqrt(disc)) / a;
  return s <= 1 ? s : -1;
}

class TreeContacts {
  constructor(trees, terrain, seed) {
    this.trees = trees;
    this.terrain = terrain;
    this.ground = trees.groundFor(terrain);
    this.seed = seed;
    this.rnd = null;        // created at the first contact: no tree, no dice
    this.depth = 0;         // crown depth (density x metres) since the last branch hit
    this.nextHit = -1;      // depth at which the next branch is met (exponential draw)
    this.hit = { part: '', spin: 1 };
    this.cx = NaN; this.cy = NaN; this.list = EMPTY; // current grid cell and its trees
    this.s = 0;             // _trunkOnPath's touching fraction
  }

  rand() {
    if (!this.rnd) this.rnd = mulberry32(this.seed);
    return this.rnd();
  }

  groundAt(i) {
    let z = this.ground[i];
    if (z !== z) z = this.ground[i] = this.terrain.h(this.trees.x[i], this.trees.y[i]);
    return z;
  }

  _hit(part, spin) {
    this.hit.part = part;
    this.hit.spin = spin;
    return this.hit;
  }

  // Trees near (x, y): the grid cell's list, looked up again only when the ball
  // crosses into another cell.
  _near(x, y) {
    const cx = Math.floor(x / CELL_M), cy = Math.floor(y / CELL_M);
    if (cx !== this.cx || cy !== this.cy) { this.cx = cx; this.cy = cy; this.list = this.trees.near(x, y); }
    return this.list;
  }

  // Earliest trunk the step (x0, y0, z0) -> pos touches, or -1, with the touching
  // fraction in this.s. A step that starts overlapping a trunk (a ball dropping out of
  // the crown onto it) touches at 0. inAir limits trunks to below their crowns.
  _trunkOnPath(list, x0, y0, z0, pos, inAir) {
    const T = this.trees;
    let best = -1, bestS = 2;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const s = sweepCircle(x0, y0, pos.x, pos.y, T.x[i], T.y[i], T.trunkR[i] + BALL_R);
      if (s < 0 || s >= bestS) continue;
      if (inAir) {
        const z = z0 + (pos.z - z0) * s, zg = this.groundAt(i);
        if (z < zg || z > zg + T.trunkTop[i]) continue;
      }
      best = i; bestS = s;
    }
    this.s = bestS;
    return best;
  }

  // Put the ball on trunk i's bark at contact point (cx, cy) and bounce its horizontal
  // velocity off it. Returns the impact speed into the trunk; 0 when the ball was only
  // nudged out (moving away) or slid along the bark (slower than QUIET_MPS).
  _offTrunk(i, cx, cy, pos, vel) {
    const T = this.trees;
    let nx = cx - T.x[i], ny = cy - T.y[i];
    let nl = Math.hypot(nx, ny);
    if (nl < 1e-9) { nx = -vel.x; ny = -vel.y; nl = Math.hypot(nx, ny); }
    if (nl < 1e-9) { nx = 1; ny = 0; nl = 1; }
    nx /= nl; ny /= nl;
    const rad = T.trunkR[i] + BALL_R + 1e-3;
    pos.x = T.x[i] + nx * rad;
    pos.y = T.y[i] + ny * rad;
    const vn = vel.x * nx + vel.y * ny;
    if (vn >= 0) return 0;
    if (-vn < QUIET_MPS) { vel.x -= vn * nx; vel.y -= vn * ny; return 0; }
    const e = TRUNK_E_MIN + (TRUNK_E_MAX - TRUNK_E_MIN) * this.rand();
    const tx = vel.x - vn * nx, ty = vel.y - vn * ny;
    vel.x = tx * TRUNK_GRIP - e * vn * nx;
    vel.y = ty * TRUNK_GRIP - e * vn * ny;
    vel.z *= TRUNK_GRIP;
    return -vn;
  }

  // Branch density at (x, y, z): the sum over the crowns that hold the point.
  _crownDensity(list, x, y, z) {
    const T = this.trees;
    let dens = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const dx = x - T.x[i], dy = y - T.y[i];
      const d2 = dx * dx + dy * dy, R = T.crownR[i];
      if (d2 > R * R) continue;
      const u = (z - this.groundAt(i) - T.base[i]) / T.span[i];
      if (!(u >= 0 && u <= 1)) continue;
      const f = T.cone[i] ? Math.pow(1 - u, CONE_EXP) : 2 * Math.sqrt(u * (1 - u));
      if (d2 <= R * R * f * f) dens += T.density[i];
    }
    return dens;
  }

  // Travel `metres` through branches of this density: true when one is hit. Hits along
  // the path are a Poisson process; a hit is due when the accumulated depth passes an
  // exponentially drawn mark.
  _meetsBranch(dens, metres) {
    if (this.nextHit < 0) this.nextHit = -Math.log(1 - this.rand());
    this.depth += dens * metres;
    if (this.depth < this.nextHit) return false;
    this.depth = 0;
    this.nextHit = -Math.log(1 - this.rand());
    return true;
  }

  // A branch hit: keep 20-60% of the speed and leave in a wide cone around the old
  // heading, biased down and back. flat = rolling (stays on the ground).
  _scatter(vel, flat) {
    const sp = Math.hypot(vel.x, vel.y, vel.z);
    if (sp < 1e-6) return;
    const ux = vel.x / sp, uy = vel.y / sp, uz = vel.z / sp;
    const back = 1 - CROWN_BACK / (Math.hypot(ux, uy) || 1);
    const qz = flat ? 0 : 2 * this.rand() - 1;          // random unit vector
    const qa = 2 * Math.PI * this.rand();
    const qr = Math.sqrt(1 - qz * qz);
    const dx = ux * back + CROWN_SCATTER * qr * Math.cos(qa);
    const dy = uy * back + CROWN_SCATTER * qr * Math.sin(qa);
    const dz = flat ? 0 : uz + CROWN_SCATTER * qz - CROWN_DOWN;
    const dl = Math.hypot(dx, dy, dz);
    const keep = CROWN_KEEP_MIN + (CROWN_KEEP_MAX - CROWN_KEEP_MIN) * this.rand();
    const v = dl > 1e-9 ? (sp * keep) / dl : 0;
    vel.x = dx * v; vel.y = dy * v; vel.z = dz * v;
  }

  /**
   * One air step from (x0, y0, z0) to pos. On a hit, pos and vel are updated and
   * {part: 'trunk'|'crown', spin: factor for the spin rate} is returned; else null.
   */
  air(x0, y0, z0, pos, vel) {
    const list = this._near(pos.x, pos.y);
    if (!list.length) return null;
    const i = this._trunkOnPath(list, x0, y0, z0, pos, true);
    if (i >= 0) {
      const s = this.s;
      pos.z = z0 + (pos.z - z0) * s;
      if (this._offTrunk(i, x0 + (pos.x - x0) * s, y0 + (pos.y - y0) * s, pos, vel) > 0) return this._hit('trunk', TRUNK_SPIN_KEEP);
      return null;
    }
    const dens = this._crownDensity(list, pos.x, pos.y, pos.z);
    if (!dens || !this._meetsBranch(dens, Math.hypot(pos.x - x0, pos.y - y0, pos.z - z0))) return null;
    this._scatter(vel, false);
    return this._hit('crown', CROWN_SPIN_KEEP);
  }

  /**
   * One roll step from (x0, y0) to pos (the ball on the ground at about pos.z): trunks
   * bounce it back, and crowns that come down to the ground (a fir's skirt) slow it.
   */
  roll(x0, y0, pos, vel) {
    const list = this._near(pos.x, pos.y);
    if (!list.length) return null;
    const i = this._trunkOnPath(list, x0, y0, 0, pos, false);
    if (i >= 0) {
      const s = this.s;
      if (this._offTrunk(i, x0 + (pos.x - x0) * s, y0 + (pos.y - y0) * s, pos, vel) > 0) return this._hit('trunk', 1);
      return null;
    }
    const dens = this._crownDensity(list, pos.x, pos.y, pos.z);
    if (!dens || !this._meetsBranch(dens, Math.hypot(pos.x - x0, pos.y - y0))) return null;
    const loud = Math.hypot(vel.x, vel.y) >= QUIET_MPS;
    this._scatter(vel, true);
    return loud ? this._hit('crown', 1) : null;
  }
}

// Per-shot contact state for simulateShot (opts.trees). seed: shotSeed().
function treeContacts(trees, terrain, seed) {
  return new TreeContacts(trees, terrain, seed);
}

module.exports = {
  buildTreeObstacles, treeContacts, shotSeed,
  speciesAt, speciesForCrown, courseDryFor, COURSE_DRY, COURSE_FLORA, floraFor, canopyHeight, TREE_MODELS, par3LineBlock,
};
