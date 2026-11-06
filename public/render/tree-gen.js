// Procedural tree models: real branch skeletons dressed in leaf / needle cards.
// Pure (no three, no DOM) so shapes and budgets are unit-tested
// (test/tree-gen.test.mjs).
//
// Broadleaves (oak, maple, birch) grow by SPACE COLONIZATION (Runions, Lane &
// Prusinkiewicz 2007): attraction points fill the species' crown envelope and
// branches grow toward them, so limbs fork and spread the way a real crown does,
// with sky showing between the leaf masses. Conifers follow their real
// architecture instead: a leader with whorls of drooping branches (spruce/fir), or
// a tall bare bole under a few layered limbs that end in needle tufts (pine).
//
// Broadleaf crowns and pine needles are CLUMPS: round leaf masses / needle tufts on
// cards that turn to face the camera (trees.js), a few hundred per crown, set where
// the twigs end and mostly in the crown's outer shell. Game trees (SpeedTree's leaf
// clusters) build canopy this way: a crown reads as one solid, lumpy mass with leafy
// edges and sky only between its lobes, from any side, where single twig cards left
// it sparse and full of spokes. Spruce and fir keep their sprigs along the branches.
//
// A model is built at its species' reference height H (metres) and scaled per
// instance to the measured tree (tree-placement.js realTreeSize). Output:
//   { species, H, crownR, crownBase, normals: 'crown' | 'axis', center, radii,
//     branches: [{ a, b, ra, rb }], cards: [{ p, right, up, ao, tile, bill?, roll? }] }
// Points are [x, y, z] with y up and the trunk base at the origin; a card's right
// and up are half-extent vectors (its texture's "up" runs along `up`). A `bill` card
// is a clump: p is its centre, right/up its half-extents as drawn facing the camera,
// roll its turn on screen.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const UP = [0, 1, 0];

// Reference shapes. base = crown base / H for an open-grown tree; forestBase for one
// grown in closed woods (shaded-out lower limbs). width = crown radius / H. leaves =
// card budget of the full model (clumps for broadleaves and pine); card = card size
// (m) at H; tile = leaf-atlas tile (leaf-atlas.js). Broadleaf heights follow mature
// Upper-Midwest parkland trees; the pine is a southern yellow pine (loblolly /
// longleaf): a tall clean bole under a lumpy crown of needle tufts.
export const TREE_SPECIES = Object.freeze({
  oak: Object.freeze({ kind: 'broad', H: 16, base: 0.22, forestBase: 0.45, width: 0.44, forestWidth: 0.3, ovoid: 0.16, lump: 0.32, up: 0.04, sag: 0.3, leaves: 420, card: 2.3, tile: 0, trunkR: 0.027, lean: 0.45 }),
  maple: Object.freeze({ kind: 'broad', H: 17, base: 0.18, forestBase: 0.42, width: 0.34, forestWidth: 0.25, ovoid: -0.06, lump: 0.22, up: 0.16, sag: 0.12, leaves: 400, card: 2.15, tile: 1, trunkR: 0.023, lean: 0.3 }),
  birch: Object.freeze({ kind: 'broad', H: 15, base: 0.32, forestBase: 0.5, width: 0.21, forestWidth: 0.17, ovoid: -0.12, lump: 0.28, up: 0.2, sag: 0.22, leaves: 300, card: 1.75, tile: 1, trunkR: 0.014, lean: 0.7, stems: 3 }),
  pine: Object.freeze({ kind: 'pine', H: 22, base: 0.55, forestBase: 0.64, width: 0.24, forestWidth: 0.18, leaves: 170, card: 2.5, tile: 3, trunkR: 0.02, lean: 0.5 }),
  fir: Object.freeze({ kind: 'spruce', H: 17, base: 0.025, forestBase: 0.2, width: 0.2, forestWidth: 0.17, leaves: 560, card: 1.25, tile: 2, trunkR: 0.02, lean: 0.15 }),
});
export const TREE_SPECIES_NAMES = Object.freeze(Object.keys(TREE_SPECIES));

// A card centred at p facing roughly `facing`, rolled `roll` radians, `size` m wide.
function card(p, facing, roll, size, ao, tile) {
  const n = norm(facing);
  const t1 = norm(cross(n, Math.abs(n[1]) > 0.92 ? [1, 0, 0] : UP));
  const t2 = cross(n, t1);
  const c = Math.cos(roll), s = Math.sin(roll), h = size / 2;
  return {
    p,
    right: mul(add(mul(t1, c), mul(t2, s)), h),
    up: mul(add(mul(t1, -s), mul(t2, c)), h),
    ao, tile,
  };
}

// A clump: a round leaf mass or needle tuft `size` m across, centred at p, that
// trees.js turns to face the camera (rolled `roll` radians on screen).
function clumpCard(p, size, roll, ao, tile) {
  const h = size / 2;
  return { p, right: [h, 0, 0], up: [0, h, 0], roll, ao, tile, bill: true };
}

// A card whose texture "up" runs along dir (a sprig growing out of a branch), its
// face tilted phi radians about dir from the horizontal.
function sprigCard(base, dir, phi, size, ao, tile) {
  const b = norm(dir);
  let n0 = sub(UP, mul(b, dot(UP, b)));
  if (len(n0) < 1e-3) n0 = [1, 0, 0];
  n0 = norm(n0);
  const side = cross(b, n0);
  const n = add(mul(n0, Math.cos(phi)), mul(side, Math.sin(phi)));
  const right = norm(cross(b, n));
  const h = size / 2;
  return { p: add(base, mul(b, h * 0.85)), right: mul(right, h), up: mul(b, h), ao, tile };
}

// Merge each run of near-collinear single-child nodes into one segment, so a 7 m
// limb is a handful of tubes, not fourteen.
function chainSegments(nodes) {
  const segs = [];
  const starts = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parent < 0) continue;
    const p = nodes[n.parent];
    if (p.parent < 0 || p.children.length !== 1) starts.push(i);
  }
  for (const s of starts) {
    let a = nodes[s].parent, cur = s;
    for (;;) {
      const dirA = norm(sub(nodes[cur].p, nodes[a].p));
      let end = cur;
      // extend while the chain is straight, unforked and short enough
      while (nodes[end].children.length === 1) {
        const nx = nodes[end].children[0];
        const d = norm(sub(nodes[nx].p, nodes[end].p));
        if (dot(d, dirA) < 0.985 || len(sub(nodes[nx].p, nodes[a].p)) > 2.4) break;
        end = nx;
      }
      segs.push({ a: nodes[a].p, b: nodes[end].p, ra: Math.min(nodes[a].r, nodes[cur].r * 1.25), rb: nodes[end].r });
      if (nodes[end].children.length !== 1) break;
      a = end; cur = nodes[end].children[0];
    }
  }
  return segs;
}

// Space colonization: grow `nodes` (with parent links) toward `points`.
function colonize(nodes, points, { di, dk, D, tropism, maxIter = 260 }) {
  const alive = points.map((p) => ({ p, live: true }));
  const cell = di;
  const key = (p) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  const grid = new Map();
  const put = (i) => { const k = key(nodes[i].p); (grid.get(k) || grid.set(k, []).get(k)).push(i); };
  nodes.forEach((_, i) => put(i));
  for (let iter = 0; iter < maxIter; iter++) {
    const pull = new Map();
    let live = 0;
    for (const a of alive) {
      if (!a.live) continue;
      const cx = Math.floor(a.p[0] / cell), cy = Math.floor(a.p[1] / cell), cz = Math.floor(a.p[2] / cell);
      let best = -1, bd = di * di;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const q = nodes[i].p;
          const d2 = (q[0] - a.p[0]) ** 2 + (q[1] - a.p[1]) ** 2 + (q[2] - a.p[2]) ** 2;
          if (d2 < bd) { bd = d2; best = i; }
        }
      }
      if (best < 0) { live++; continue; }
      if (bd < dk * dk) { a.live = false; continue; }   // reached: this space is filled
      live++;
      const v = norm(sub(a.p, nodes[best].p));
      const s = pull.get(best);
      if (s) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; } else pull.set(best, [v[0], v[1], v[2]]);
    }
    if (!pull.size || !live) break;
    let grew = 0;
    for (const [i, s] of pull) {
      if (len(s) < 0.15) continue;   // pulled from opposite sides: let a neighbour take it
      const n = nodes[i];
      const dir = norm(tropism(norm(s), n.p));
      const p = add(n.p, mul(dir, D));
      if (n.children.some((c) => len(sub(nodes[c].p, p)) < D * 0.35)) continue;
      nodes.push({ p, parent: i, children: [], r: 0 });
      n.children.push(nodes.length - 1);
      put(nodes.length - 1);
      grew++;
    }
    if (!grew) break;
  }
}

// Pipe model: a branch's cross-section carries its children's (exponent 2.5), so
// limbs thin as they fork. Returns the tip count under every node.
function pipeRadii(nodes, rTip) {
  const tips = new Array(nodes.length).fill(0);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n.children.length) { n.r = rTip; tips[i] = 1; continue; }
    let s = 0;
    for (const c of n.children) { s += nodes[c].r ** 2.5; tips[i] += tips[c]; }
    n.r = s ** (1 / 2.5);
  }
  return tips;
}

function broadleaf(sp, r, forest) {
  const H = sp.H, sc = H / 16;
  const yb = H * (forest ? sp.forestBase : sp.base) * (0.88 + 0.24 * r());
  const rx = H * (forest ? sp.forestWidth : sp.width) * (0.86 + 0.28 * r());
  const ry = (H - yb) / 2, cy = yb + ry;
  // lobes: a handful of bulges so no two crowns share a silhouette
  const lobes = [];
  for (let k = 0; k < 8; k++) {
    const th = r() * Math.PI * 2, el = (r() - 0.35) * 1.1;
    lobes.push({ d: norm([Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el)]), a: 0.45 + 0.55 * r() });
  }
  const shell = (d) => { let m = 1 - sp.lump * 0.6; for (const l of lobes) m += sp.lump * l.a * Math.max(0, dot(d, l.d)) ** 3; return m; };
  const local = (p) => { const dy = (p[1] - cy) / ry; const rxy = rx * (1 - sp.ovoid * dy); return [p[0] / rxy, dy, p[2] / rxy]; };
  const inside = (p) => { const q = local(p); const d = len(q); return d < 1e-6 || d <= shell(mul(q, 1 / d)); };

  const target = Math.round(sp.leaves * (forest ? 0.72 : 1));
  const points = [];
  for (let tries = 0; points.length < target * 1.3 && tries < target * 60; tries++) {
    const p = [(r() * 2 - 1) * rx * 1.4, yb + r() * (H - yb) * 1.02, (r() * 2 - 1) * rx * 1.4];
    if (inside(p)) points.push(p);
  }
  // trunk(s): a slightly bent, leaning bole running a little way into the crown
  const nodes = [];
  const stems = sp.stems ? 1 + Math.floor(r() * sp.stems) : 1;
  const D = 0.5 * sc;
  for (let s = 0; s < stems; s++) {
    const az = r() * Math.PI * 2;
    const lean = stems > 1 ? sp.lean * (0.8 + 0.6 * r()) : sp.lean * r();
    const off = stems > 1 ? 0.22 * sc : 0;
    const base = [Math.cos(az) * off, 0, Math.sin(az) * off];
    const top = yb + (H - yb) * (stems > 1 ? 0.3 : 0.14);
    const steps = Math.max(3, Math.round(top / (D * 2)));
    let prev = -1;
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const bend = Math.sin(f * Math.PI) * 0.12 * sc * (r() - 0.5);
      const p = [base[0] + Math.cos(az) * lean * f * f + bend, top * f, base[2] + Math.sin(az) * lean * f * f + bend];
      nodes.push({ p, parent: prev, children: [], r: 0 });
      if (prev >= 0) nodes[prev].children.push(nodes.length - 1);
      prev = nodes.length - 1;
    }
  }
  colonize(nodes, points, {
    di: Math.max(2.4 * sc, rx * 0.5), dk: 0.95 * sc, D,
    // gentle phototropism; long lower limbs arch out and down under their weight
    tropism: (dir, p) => {
      const reach = Math.hypot(p[0], p[2]) / rx;
      return add(dir, [0, sp.up - sp.sag * reach * reach * (p[1] < cy ? 1 : 0.4), 0]);
    },
  });
  const tips = pipeRadii(nodes, 0.01);
  const roots = nodes.filter((n) => n.parent < 0);
  // normalise to the species' bole, then thin the outer crown faster than the pure
  // pipe model does (it leaves 3-4 cm "twigs" on a 500-tip crown)
  const rRoot = Math.max(...roots.map((n) => n.r));
  for (const n of nodes) n.r = sp.trunkR * H * (n.r / rRoot) ** 1.8;

  // leaf cards on the fine twigs: every tip, plus twig nodes carrying few tips
  const cand = [];
  nodes.forEach((n, i) => { if (!n.children.length || (tips[i] <= 3 && n.p[1] > yb * 0.9)) cand.push(n.p); });
  const C = [0, cy, 0];
  const cards = [];
  const pick = cand.slice();
  for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
  // clumps where the twigs end, mostly in the crown's outer shell: one deep inside the
  // mass is hidden by the ones around it, so most of those are skipped
  for (let i = 0, tries = 0; cards.length < target && tries < target * 6; i++, tries++) {
    const base = pick[i % pick.length];
    const spread = i < pick.length ? 0.45 : 0.9;
    const p = add(base, mul([r() - 0.5, r() - 0.5, r() - 0.5], 2 * spread * sc));
    const q = local(p);
    const d = len(q) || 1e-6;
    const rel = d / shell(mul(q, 1 / d));   // 0 at the crown's core, 1 on its surface
    if (rel < 0.55 && r() < 0.7) continue;
    const size = sp.card * sc * (0.75 + 0.5 * r()) * (0.8 + 0.25 * Math.min(1, rel));
    // a little light variation clump to clump, so the crown isn't one even tone
    cards.push(clumpCard(p, size, r() * Math.PI * 2, Math.min(1, Math.max(0.15, rel)) * (0.8 + 0.2 * r()), sp.tile));
  }
  return finish({ H, crownBase: yb, normals: 'crown', center: C, radii: [rx, ry], branches: chainSegments(nodes), cards });
}

function spruce(sp, r, forest) {
  const H = sp.H, sc = H / 17;
  const y0 = H * (forest ? sp.forestBase : sp.base) + 0.25 * sc;
  const R = H * (forest ? sp.forestWidth : sp.width) * (0.88 + 0.24 * r());
  const lean = [Math.cos(r() * 6.283) * sp.lean, 0, Math.sin(r() * 6.283) * sp.lean];
  const axis = (y) => add([0, y, 0], mul(lean, (y / H) ** 2));
  const branches = [];
  const cards = [];
  const rT = sp.trunkR * H;
  const trunkR = (y) => rT * (1 - y / H) ** 0.9 + 0.015 * sc;
  for (let y = 0; y < H - 0.4 * sc; y += 1.4 * sc) {
    const y2 = Math.min(H - 0.4 * sc, y + 1.4 * sc);
    branches.push({ a: axis(y), b: axis(y2), ra: trunkR(y), rb: trunkR(y2) });
  }
  let w = 0;
  for (let y = y0; y < H - 0.45 * sc; y += 0.42 * sc * (0.8 + 0.4 * r()), w++) {
    const t = (y - y0) / (H - y0);
    const n = 4 + Math.floor(r() * 3);
    const az0 = w * 2.39996 + r();
    for (let k = 0; k < n; k++) {
      if (r() < 0.12) continue;   // a missing branch: light gets into the tier
      const a = az0 + (k / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const L = R * (1 - t) ** 0.9 * (0.8 + 0.4 * r()) + 0.35 * sc;
      const droop = 0.22 - 0.55 * (1 - t);
      const dir = norm([Math.cos(a), droop, Math.sin(a)]);
      const start = axis(y);
      const mid = add(start, mul(dir, L * 0.55));
      const tipDir = norm(add(dir, [0, 0.28, 0]));
      const tip = add(mid, mul(tipDir, L * 0.45));
      const rb0 = 0.012 * sc + 0.028 * sc * (L / R);
      branches.push({ a: start, b: mid, ra: rb0, rb: rb0 * 0.6 }, { a: mid, b: tip, ra: rb0 * 0.6, rb: 0.008 * sc });
      const m = Math.max(1, Math.round(L / (0.52 * sc)));
      for (let j = 0; j < m; j++) {
        const f = (j + 0.25 + r() * 0.5) / m;
        const at = f < 0.55 ? lerp3(start, mid, f / 0.55) : lerp3(mid, tip, (f - 0.55) / 0.45);
        const bd = f < 0.55 ? dir : tipDir;
        const phi = (j % 2 ? 1 : -1) * (0.5 + r() * 0.45);
        const size = sp.card * sc * (0.62 + 0.45 * (L / R)) * (0.85 + 0.3 * r());
        cards.push(sprigCard(at, add(bd, [(r() - 0.5) * 0.3, 0, (r() - 0.5) * 0.3]), phi, size, Math.min(1, 0.3 + 0.75 * f), sp.tile));
      }
    }
  }
  // the leader: two crossed upright sprigs
  for (const phi of [0, Math.PI / 2]) cards.push(sprigCard(axis(H - 1.15 * sc), UP, phi, 1.15 * sc, 1, sp.tile));
  return finish({ H, crownBase: y0, normals: 'axis', center: [0, (y0 + H) / 2, 0], radii: [R, (H - y0) / 2], branches, cards, lean });
}

function pine(sp, r, forest) {
  const H = sp.H, sc = H / 22;
  const yb = H * (forest ? sp.forestBase : sp.base) * (0.92 + 0.16 * r());
  const R = H * (forest ? sp.forestWidth : sp.width) * (0.85 + 0.3 * r());
  const leanDir = r() * Math.PI * 2;
  const lean = [Math.cos(leanDir) * sp.lean, 0, Math.sin(leanDir) * sp.lean];
  const axis = (y) => add([0, y, 0], mul(lean, (y / H) ** 1.5));
  const rT = sp.trunkR * H;
  const trunkR = (y) => rT * (1 - 0.8 * y / H);
  const branches = [];
  const cards = [];
  const top = H - 1.2 * sc;
  for (let y = 0; y < top; y += 2 * sc) {
    const y2 = Math.min(top, y + 2 * sc);
    branches.push({ a: axis(y), b: axis(y2), ra: trunkR(y), rb: trunkR(y2) });
  }
  const ry = (H - yb) / 2, cy = yb + ry;
  const tuft = (at, scale, ao) => cards.push(clumpCard(add(at, mul([r() - 0.5, r() - 0.5, r() - 0.5], 0.5 * sc)),
    sp.card * sc * scale * (0.8 + 0.4 * r()), r() * Math.PI * 2, Math.min(1, ao), sp.tile));
  const hd = (p) => Math.min(1, Math.hypot(p[0], p[2]) / R);
  // whorls of upswept limbs that level off, each carrying needle tufts at its tip and
  // along its outer half; a rounded, slightly flat-topped crown widest a third of the
  // way up, with sky between the limbs
  let w = 0;
  for (let y = yb; y < H - 1.3 * sc; y += 0.6 * sc * (0.75 + 0.5 * r()), w++) {
    const t = (y - yb) / (H - yb);
    const prof = Math.sin(Math.PI * Math.min(1, 0.22 + t * 0.85)) ** 0.6;
    const n = 3 + Math.floor(r() * 3);
    const az0 = w * 2.39996 + r();
    for (let k = 0; k < n; k++) {
      if (r() < 0.18) continue;
      const a = az0 + (k / n) * Math.PI * 2 + (r() - 0.5) * 0.8;
      const L = R * (0.3 + 0.8 * prof) * (0.7 + 0.5 * r());
      const dir = norm([Math.cos(a), 0.45 - 0.25 * t + 0.25 * r(), Math.sin(a)]);
      const start = axis(y);
      const mid = add(start, mul(dir, L * 0.55));
      const tipDir = norm(add(dir, [0, -0.15 + 0.3 * r(), 0]));
      const tip = add(mid, mul(tipDir, L * 0.45));
      const rb0 = 0.025 * sc + 0.06 * sc * (L / R);
      branches.push({ a: start, b: mid, ra: rb0, rb: rb0 * 0.6 }, { a: mid, b: tip, ra: rb0 * 0.6, rb: 0.012 * sc });
      tuft(tip, 1, 0.75 + 0.25 * r());
      tuft(lerp3(mid, tip, 0.45), 0.9, 0.5 + 0.4 * hd(mid));
      if (L > 1.5 * sc) tuft(lerp3(start, mid, 0.7), 0.8, 0.4 + 0.4 * hd(mid));
      if (r() < 0.6) {
        const fork = norm(add(tipDir, [Math.cos(a + 1.57) * (r() - 0.5) * 1.8, 0.2, Math.sin(a + 1.57) * (r() - 0.5) * 1.8]));
        const ftip = add(mid, mul(fork, L * 0.5));
        branches.push({ a: mid, b: ftip, ra: rb0 * 0.5, rb: 0.01 * sc });
        tuft(ftip, 0.9, 0.7 + 0.3 * r());
      }
    }
  }
  // the top: a few tufts round the leader
  for (let k = 0; k < 4; k++) {
    tuft(add(axis(H - 1.2 * sc), [Math.cos(k * 1.6) * 0.6 * sc, (r() - 0.3) * 0.8 * sc, Math.sin(k * 1.6) * 0.6 * sc]), 0.85, 0.95);
  }
  return finish({ H, crownBase: yb, normals: 'crown', center: [0, cy, 0], radii: [R, ry], branches, cards, lean });
}

function finish(m) {
  // crown radius for sizing measured trees: the 95th percentile card reach
  const reach = m.cards.map((c) => Math.hypot(c.p[0], c.p[2]) + len(c.right) * 0.5).sort((a, b) => a - b);
  m.crownR = reach.length ? reach[Math.floor(reach.length * 0.95)] : m.radii[0];
  return m;
}

export function generateTree(species, seed = 1, { forest = false } = {}) {
  const sp = TREE_SPECIES[species] || TREE_SPECIES.oak;
  const r = mulberry32((seed >>> 0) * 2654435761 + 97);
  const m = sp.kind === 'broad' ? broadleaf(sp, r, forest) : sp.kind === 'pine' ? pine(sp, r, forest) : spruce(sp, r, forest);
  m.species = TREE_SPECIES[species] ? species : 'oak';
  return m;
}

// A lower level of detail: keep 1 in `every` cards (seeded shuffle), each grown by
// ~sqrt(every) so the crown keeps its coverage and silhouette. With `cross`, every
// kept card becomes three crossed ones (two upright, one flat) so the thinned crown
// stays solid from any side and from above — single cards facing out of the crown
// are edge-on to a camera overhead.
export function thinCards(cards, every, seed = 1, { cross: crossed = false } = {}) {
  if (every <= 1) return cards.slice();
  const r = mulberry32(seed * 977 + every);
  const order = cards.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const keep = Math.max(1, Math.round(cards.length / every));
  const g = Math.sqrt(cards.length / keep) * 0.82;
  const out = [];
  for (const i of order.slice(0, keep)) {
    const c = cards[i];
    // a clump faces the camera already: it only grows
    if (!crossed || c.bill) { out.push({ ...c, right: mul(c.right, g), up: mul(c.up, g) }); continue; }
    const h = Math.hypot(...c.right) * g;
    const roll = r() * Math.PI * 2;
    for (const facing of [[Math.cos(roll), 0, Math.sin(roll)], [-Math.sin(roll), 0, Math.cos(roll)], [0, 1, 0]]) {
      out.push(card(c.p, facing, r() * Math.PI * 2, h * 2, c.ao, c.tile));
    }
  }
  return out;
}
