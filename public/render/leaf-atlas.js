// Photographic leaf atlas for the 3D trees, composed at load from CC0 Poly Haven
// scans (ASSETS.md): single scanned leaves arranged into clusters along twigs, a
// spruce sprig and a pine needle spray. 1024^2, 2x2 tiles (tree-gen.js `tile`):
//   [0] broadleaf cluster (oak, maple)   [1] small-leaf cluster (birch)
//   [2] spruce / fir sprig                [3] pine needle tuft
// Sprigs grow "up" the tile from its bottom centre, so a card's up vector can run
// along its branch. Colour is opaque (each tile's background is its mean foliage
// colour so mips don't fringe dark); coverage is a separate alpha map with a
// coverage-preserving mip chain (alpha-mips.js). The textures exist at once and
// fill in when the source photos arrive (tracked by THREE.DefaultLoadingManager, so
// visual capture waits for them).
import * as THREE from 'three';
import { ASSETS } from './assets.js';
import { coverageMipChain } from './alpha-mips.js';

const S = 1024, T = S / 2;
export const ATLAS_TILE_UV = Object.freeze([[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]]); // (u0, v0) per tile, v up

// Source boxes [x0, y0, x1, y1] (px) — leaves and sprigs with the stem at the bottom.
const LEAF_BOXES = [[169, 21, 345, 401], [222, 591, 363, 1024], [18, 645, 186, 1024], [17, 21, 148, 523],
  [711, 21, 835, 423], [530, 51, 664, 371], [433, 618, 575, 1024], [370, 33, 494, 370]];
const FIR_BOXES = [[313, 410, 660, 794], [650, 463, 975, 850], [669, 53, 960, 378], [194, 48, 426, 319]];
const PINE_BOX = [8, 8, 197, 415];

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
    pineDiff: ASSETS.trees.pineTwigDiff, pineAlpha: ASSETS.trees.pineTwigAlpha,
  };
  const img = {};
  let left = Object.keys(want).length;
  const compose = () => {
    const r = rng(424242);
    const leaves = LEAF_BOXES.map((b) => sprite(img.leafDiff, img.leafAlpha, b));
    const firs = FIR_BOXES.map((b) => sprite(img.firDiff, img.firAlpha, b));
    const pine = sprite(img.pineDiff, img.pineAlpha, PINE_BOX);
    // [0] oak / maple: dense, deep-green leaves (~15 cm on a 1.5 m card)
    leafCluster(cc, ac, 0, 0, leaves, r, { n: 210, size: 0.105, hue: 100, sat: 30, light: 19, toneHue: 10 });
    // [1] birch: many small, lighter leaves
    leafCluster(cc, ac, T, 0, leaves, r, { n: 300, size: 0.075, hue: 88, sat: 36, light: 26, toneHue: 16 });
    // [2] spruce: a full sprig with two behind it, blue-green
    sprigFan(cc, ac, 0, T, firs, r, { bg: 'hsl(128,22%,20%)', fans: [[-0.42, 0.72], [0.4, 0.74], [0, 1]], tone: 'saturate(0.8) hue-rotate(14deg)' });
    // [3] pine: a fan of long needle sprays (a tuft)
    sprigFan(cc, ac, T, T, [pine], r, { bg: 'hsl(88,20%,24%)', fans: [[-0.5, 0.8], [0.5, 0.8], [-0.2, 0.95], [0.22, 0.95], [0, 1]], tone: 'saturate(1.05)' });
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
