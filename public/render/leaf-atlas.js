// Photographic leaf atlas for the 3D trees, composed at load from CC0 Poly Haven
// scans (ASSETS.md) and drawn needles. 1024^2, 2x2 tiles (tree-gen.js `tile`):
//   [0] broadleaf clump (oak, maple)      [1] small-leaf clump (birch, maple)
//   [2] spruce / fir sprig                [3] pine needle tuft
// The broadleaf and pine tiles are dense, roughly round foliage MASSES drawn for
// camera-facing clump cards (trees.js): a crown is a few hundred of them, the way game
// trees (SpeedTree's leaf clusters) read as solid canopy with leafy edges from any
// side. The old tiles were single twigs on a long bare stem, which left crowns sparse
// and full of spokes. Scanned leaves radiate from hidden twigs inside a lobed blob,
// the back layers darker; pine tufts are fascicles of long needles bursting from a
// twig tip (loblolly / longleaf). The spruce tile is a sprig that grows "up" the tile
// from its bottom centre, so a card's up vector can run along its branch. Colour is
// opaque (each tile's background is its mean foliage colour so mips don't fringe
// dark); coverage is a separate alpha map with a coverage-preserving mip chain
// (alpha-mips.js). The textures exist at once and fill in when the source photos
// arrive (tracked by THREE.DefaultLoadingManager, so visual capture waits for them).
import * as THREE from 'three';
import { ASSETS } from './assets.js';
import { coverageMipChain } from './alpha-mips.js';

const S = 1024, T = S / 2;
export const ATLAS_TILE_UV = Object.freeze([[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]]); // (u0, v0) per tile, v up

// Source boxes [x0, y0, x1, y1] (px) — leaves and sprigs with the stem at the bottom.
const LEAF_BOXES = [[169, 21, 345, 401], [222, 591, 363, 1024], [18, 645, 186, 1024], [17, 21, 148, 523],
  [711, 21, 835, 423], [530, 51, 664, 371], [433, 618, 575, 1024], [370, 33, 494, 370]];
const FIR_BOXES = [[313, 410, 660, 794], [650, 463, 975, 850], [669, 53, 960, 378], [194, 48, 426, 319]];

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One RGBA sprite: colour from the diffuse scan, alpha from its cutout.
function sprite(diff, alpha, [x0, y0, x1, y1]) {
  const w = x1 - x0, h = y1 - y0;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(alpha, x0, y0, w, h, 0, 0, w, h);
  const a = g.getImageData(0, 0, w, h).data;
  g.clearRect(0, 0, w, h);
  g.drawImage(diff, x0, y0, w, h, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = a[i * 4];
  g.putImageData(img, 0, 0);
  return c;
}

// Draw a sprite with its stem at (x, y), growing toward angle `dir` (radians, canvas
// space), `len` px long — on the colour canvas with a tone filter and on the alpha
// canvas as a white silhouette.
function stamp(cc, ac, s, x, y, dir, lenPx, tone) {
  const h = lenPx, w = lenPx * (s.width / s.height);
  for (const [g, filter] of [[cc, tone], [ac, 'brightness(0) invert(1)']]) {
    g.save();
    g.translate(x, y); g.rotate(dir + Math.PI / 2);
    g.filter = filter;
    g.drawImage(s, -w / 2, -h, w, h);
    g.restore();
  }
}

function stroke(cc, ac, pts, width, colour) {
  for (const [g, col, wd] of [[cc, colour, width], [ac, '#fff', width + 1]]) {
    g.save(); g.strokeStyle = col; g.lineWidth = wd; g.lineCap = 'round';
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.stroke(); g.restore();
  }
}

// A leafy twig: a main stem up the tile with alternating side twigs, leaves along
// both, darker inner leaves drawn first and brighter outer ones on top.
function leafCluster(cc, ac, ox, oy, leaves, r, { n, size, hue, sat, light, toneHue }) {
  cc.fillStyle = `hsl(${hue},${sat}%,${light}%)`; cc.fillRect(ox, oy, T, T);
  const twigs = [];
  const base = [ox + T * (0.46 + r() * 0.08), oy + T * 0.99];
  const top = [ox + T * (0.4 + r() * 0.2), oy + T * 0.1];
  twigs.push([base, top]);
  for (let k = 0; k < 6; k++) {
    const f = 0.25 + k * 0.11 + r() * 0.05;
    const at = [base[0] + (top[0] - base[0]) * f, base[1] + (top[1] - base[1]) * f];
    const side = k % 2 ? 1 : -1;
    const ang = -Math.PI / 2 + side * (0.65 + r() * 0.45);
    const L = T * (0.22 + r() * 0.16) * (1 - f * 0.4);
    twigs.push([at, [at[0] + Math.cos(ang) * L, at[1] + Math.sin(ang) * L]]);
  }
  for (const [a, b] of twigs) stroke(cc, ac, [a, b], 3, '#4b3a2b');
  const spots = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = twigs[Math.floor(r() * twigs.length)];
    const f = 0.2 + r() * 0.8;
    const at = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const tw = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const dir = tw + (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.75);
    spots.push({ at, dir, len: T * size * (0.7 + r() * 0.5), depth: r() });
  }
  spots.sort((p, q) => p.depth - q.depth);
  for (const sp of spots) {
    const s = leaves[Math.floor(r() * leaves.length)];
    const b = 0.55 + sp.depth * 0.4 + (r() - 0.5) * 0.1;
    const tone = `brightness(${b.toFixed(3)}) saturate(${(0.72 + r() * 0.26).toFixed(3)}) hue-rotate(${(toneHue + (r() - 0.5) * 12).toFixed(1)}deg)`;
    stamp(cc, ac, s, sp.at[0], sp.at[1], sp.dir, sp.len, tone);
  }
}

// Keep a tile's strokes inside it (a leaf poking past the edge would bleed into the
// neighbouring tile), with a 3 px margin for the mip chain.
function clipTile(gs, ox, oy, fn) {
  for (const g of gs) { g.save(); g.beginPath(); g.rect(ox + 3, oy + 3, T - 6, T - 6); g.clip(); }
  try { fn(); } finally { for (const g of gs) g.restore(); }
}

// A dense, rounded leaf mass: scanned leaves radiating from hidden twigs inside a blob
// of a few overlapping lobes, drawn back to front with the back (and inner) leaves
// darker, so the clump has depth and a leafy, broken outline. Round on purpose: the
// card turns to face the camera at a random roll (trees.js).
function leafClump(cc, ac, ox, oy, leaves, r, { n, size, hue, sat, light, toneHue }) {
  cc.fillStyle = `hsl(${hue},${sat}%,${light}%)`; cc.fillRect(ox, oy, T, T);
  const cx = ox + T / 2, cy = oy + T / 2;
  // an irregular outline: a smaller core and lobes pushed further out, so no two
  // clumps in a crown share the same round silhouette (a crown of discs read as cotton)
  const lobes = [{ x: 0, y: 0, rad: 0.2 }];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + r() * 0.7, d = 0.12 + r() * 0.12;
    lobes.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, rad: 0.08 + r() * 0.1 });
  }
  const inside = (u, v) => lobes.some((l) => (u - l.x) ** 2 + (v - l.y) ** 2 < l.rad * l.rad);
  clipTile([cc, ac], ox, oy, () => {
    for (let k = 0; k < 9; k++) {
      const a = r() * Math.PI * 2, L = T * (0.18 + r() * 0.14);
      stroke(cc, ac, [[cx + (r() - 0.5) * T * 0.06, cy + (r() - 0.5) * T * 0.06], [cx + Math.cos(a) * L, cy + Math.sin(a) * L]], 2.5, '#3f3125');
    }
    const spots = [];
    for (let tries = 0; spots.length < n && tries < n * 40; tries++) {
      const u = (r() - 0.5) * 0.8, v = (r() - 0.5) * 0.8;
      if (!inside(u, v)) continue;
      const out = Math.atan2(v, u), rr = Math.hypot(u, v);
      spots.push({ at: [cx + u * T, cy + v * T], dir: out + (r() - 0.5) * 2.2, len: T * size * (0.7 + r() * 0.55), depth: r(), rr });
    }
    spots.sort((p, q) => p.depth - q.depth);
    for (const sp of spots) {
      const s = leaves[Math.floor(r() * leaves.length)];
      // back leaves dark (inside the clump's own shade) — but only toward the middle: the
      // rim stays lit, or every clump wore a dark halo where its back leaves stick out
      const rim = Math.min(1, sp.rr / 0.34);
      const b = 0.5 + 0.48 * Math.max(sp.depth, rim * rim * 0.85) + (r() - 0.5) * 0.1;
      const tone = `brightness(${b.toFixed(3)}) saturate(${(0.7 + r() * 0.28).toFixed(3)}) hue-rotate(${(toneHue + (r() - 0.5) * 14).toFixed(1)}deg)`;
      stamp(cc, ac, s, sp.at[0], sp.at[1], sp.dir, sp.len, tone);
    }
  });
}

// A pine needle tuft: fascicles of long needles bursting from a twig tip in every
// direction — a crown of these, with sky between them, is how a loblolly or longleaf
// pine reads from the fairway. Back needles dark, front ones lit, a few sun-bleached.
function pineTuft(cc, ac, ox, oy, r, { bg, n }) {
  cc.fillStyle = bg; cc.fillRect(ox, oy, T, T);
  const cx = ox + T / 2, cy = oy + T / 2;
  const dark = [27, 38, 22], lit = [84, 102, 54], straw = [126, 118, 70];
  const fas = [];
  for (let i = 0; i < n; i++) {
    const oa = r() * Math.PI * 2, o = Math.sqrt(r()) * 0.08 * T;
    fas.push({ x: cx + Math.cos(oa) * o, y: cy + Math.sin(oa) * o, a: r() * Math.PI * 2, L: T * (0.17 + r() * 0.24), depth: r(), bend: (r() - 0.5) * 0.45 });
  }
  fas.sort((p, q) => p.depth - q.depth);
  clipTile([cc, ac], ox, oy, () => {
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2;
      stroke(cc, ac, [[cx, cy], [cx + Math.cos(a) * T * 0.07, cy + Math.sin(a) * T * 0.07]], 4, '#4a3524');
    }
    for (const f of fas) {
      const t = Math.min(1, f.depth * 1.1 + (r() - 0.5) * 0.15);
      let col = dark.map((d, k) => d + (lit[k] - d) * t);
      if (r() < 0.03) col = straw;
      const css = `rgb(${col.map((v) => Math.round(v * (0.9 + r() * 0.2))).join(',')})`;
      for (let k = -1; k <= 1; k++) {
        const a = f.a + k * 0.05;
        const ex = f.x + Math.cos(a) * f.L, ey = f.y + Math.sin(a) * f.L;
        const mx = f.x + Math.cos(a) * f.L * 0.5 - Math.sin(a) * f.L * f.bend * 0.3;
        const my = f.y + Math.sin(a) * f.L * 0.5 + Math.cos(a) * f.L * f.bend * 0.3;
        const w = 1.3 + r() * 0.9;
        for (const [g, c, wd] of [[cc, css, w], [ac, '#fff', w + 0.6]]) {
          g.strokeStyle = c; g.lineWidth = wd; g.lineCap = 'round';
          g.beginPath(); g.moveTo(f.x, f.y); g.quadraticCurveTo(mx, my, ex, ey); g.stroke();
        }
      }
    }
  });
}

// Sprigs fanned from the bottom centre of a tile (conifers).
function sprigFan(cc, ac, ox, oy, sprigs, r, { bg, fans, tone }) {
  cc.fillStyle = bg; cc.fillRect(ox, oy, T, T);
  const x = ox + T / 2, y = oy + T * 0.985;
  fans.forEach(([ang, scale], i) => {
    const s = sprigs[i % sprigs.length];
    const t = `${tone} brightness(${(0.82 + r() * 0.3).toFixed(3)})`;
    stamp(cc, ac, s, x, y, -Math.PI / 2 + ang, T * 0.95 * scale, t);
  });
}

let ATLAS = null;
export function leafAtlas() {
  if (ATLAS) return ATLAS;
  const col = document.createElement('canvas'); col.width = col.height = S;
  const alp = document.createElement('canvas'); alp.width = alp.height = S;
  const cc = col.getContext('2d'), ac = alp.getContext('2d', { willReadFrequently: true });
  cc.fillStyle = '#4f6a31'; cc.fillRect(0, 0, S, S);
  ac.fillStyle = '#000'; ac.fillRect(0, 0, S, S);
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  // the full (empty) mip chain up front: GPU storage is allocated once, at the first
  // upload, so the levels filled in later must already exist
  const empty = [];
  for (let w = S; w >= 1; w >>= 1) empty.push({ data: new Uint8Array(w * w * 4), width: w, height: w });
  const alphaMap = new THREE.DataTexture(empty[0].data, S, S, THREE.RGBAFormat);
  alphaMap.mipmaps = empty;
  alphaMap.minFilter = THREE.LinearMipmapLinearFilter;
  alphaMap.magFilter = THREE.LinearFilter;
  alphaMap.colorSpace = THREE.NoColorSpace;
  alphaMap.anisotropy = 4;
  alphaMap.generateMipmaps = false;
  ATLAS = { map, alphaMap, ready: false };

  const loader = new THREE.ImageLoader();
  const want = {
    leafDiff: ASSETS.trees.leafDiff, leafAlpha: ASSETS.trees.leafAlpha,
    firDiff: ASSETS.trees.foliageDiff, firAlpha: ASSETS.trees.foliageAlpha,
  };
  const img = {};
  let left = Object.keys(want).length;
  const compose = () => {
    const r = rng(424242);
    const leaves = LEAF_BOXES.map((b) => sprite(img.leafDiff, img.leafAlpha, b));
    const firs = FIR_BOXES.map((b) => sprite(img.firDiff, img.firAlpha, b));
    // [0] oak / maple: a dense clump of deep-green leaves (~10 cm on a 2.7 m card)
    leafClump(cc, ac, 0, 0, leaves, r, { n: 560, size: 0.072, hue: 96, sat: 28, light: 20, toneHue: 8 });
    // [1] birch / maple: smaller, lighter leaves
    leafClump(cc, ac, T, 0, leaves, r, { n: 700, size: 0.058, hue: 88, sat: 34, light: 25, toneHue: 14 });
    // [2] spruce: a full sprig with two behind it, blue-green
    sprigFan(cc, ac, 0, T, firs, r, { bg: 'hsl(128,22%,20%)', fans: [[-0.42, 0.72], [0.4, 0.74], [0, 1]], tone: 'saturate(0.8) hue-rotate(14deg)' });
    // [3] pine: a needle tuft
    pineTuft(cc, ac, T, T, r, { bg: 'hsl(86,24%,20%)', n: 360 });
    map.needsUpdate = true;
    // coverage-preserving alpha mips, rows flipped bottom-up to match the
    // CanvasTexture (flipY) UV convention of the colour map
    const src = ac.getImageData(0, 0, S, S).data;
    const a0 = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) a0[(S - 1 - y) * S + x] = src[(y * S + x) * 4];
    coverageMipChain(a0, S, S, { tiles: 2, cutoff: 128 }).forEach((lvl, k) => {
      const d = empty[k].data;
      for (let i = 0; i < lvl.w * lvl.h; i++) { const v = lvl.alpha[i]; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    });
    alphaMap.needsUpdate = true;
    ATLAS.ready = true;
  };
  for (const [k, url] of Object.entries(want)) {
    loader.load(url, (im) => { img[k] = im; if (--left === 0) compose(); }, undefined,
      (e) => console.warn('[trees] leaf atlas source failed:', url, e?.message || e));
  }
  return ATLAS;
}

// Birch bark: chalk-white with dark lenticels and a darker, fissured foot.
export function birchBark() {
  const W = 256, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = rng(77);
  g.fillStyle = '#e4e0d6'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 1400; i++) {
    const v = 200 + Math.floor(r() * 40);
    g.fillStyle = `rgba(${v},${v - 4},${v - 12},0.35)`;
    g.fillRect(r() * W, r() * H, 2 + r() * 6, 1 + r() * 3);
  }
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(32,28,26,${(0.55 + r() * 0.4).toFixed(2)})`;
    g.fillRect(r() * W, r() * H, 6 + r() * 34, 1.5 + r() * 3.5);
  }
  const foot = g.createLinearGradient(0, H * 0.82, 0, H);
  foot.addColorStop(0, 'rgba(40,36,32,0)'); foot.addColorStop(1, 'rgba(40,36,32,0.75)');
  g.fillStyle = foot; g.fillRect(0, H * 0.82, W, H * 0.18);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
