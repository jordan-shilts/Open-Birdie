// Ground vegetation that frames a hole: a warm pine-straw litter mat under the
// trees (the reddish-brown carpet you find under pines) and azalea-style flower
// clusters at the green surrounds + tree lines. Both are GPU-instanced single
// draw calls with procedurally-drawn textures (no asset files), lit by the scene
// so they sit in the same light as everything else.
import * as THREE from 'three';
import { RENDER_CONFIG } from './config.js';
import { BILLBOARD_PROJECT, BILLBOARD_NORMAL, BILLBOARD_WORLDPOS } from './trees.js';

export function deterministicRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function vegetationTextureCommands(kind) {
  if (kind === 'straw') {
    const rnd = deterministicRandom(0x51a7);
    const s = 256;
    const cols = ['#7a4a26', '#8c5a30', '#6b3f22', '#9c6a3c', '#5e3a20'];
    const commands = [];
    for (let i = 0; i < 1500; i++) {
      const ang = rnd() * Math.PI * 2;
      const rad = Math.pow(rnd(), 0.6) * (s * 0.5);
      const a = 1 - rad / (s * 0.5);
      if (a <= 0) continue;
      const cx = s / 2 + Math.cos(ang) * rad, cy = s / 2 + Math.sin(ang) * rad;
      const len = 6 + rnd() * 12, dir = rnd() * Math.PI * 2;
      commands.push({
        cx, cy,
        x2: cx + Math.cos(dir) * len,
        y2: cy + Math.sin(dir) * len,
        color: cols[(rnd() * cols.length) | 0],
        alpha: 0.5 * a * (0.6 + rnd() * 0.4),
        lineWidth: 1 + rnd() * 1.4,
      });
    }
    return commands;
  }
  if (kind === 'flower') {
    // an azalea clump: a dense, irregular mass of small dark leaves, then blossoms
    // (white: the bush's colour tints them) crowded over its upper two thirds
    const rnd = deterministicRandom(0xf10b);
    const s = 256;
    const commands = [];
    const lobes = [{ x: 0, y: 0.04, r: 0.24 }];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + rnd() * 0.8, d = 0.1 + rnd() * 0.1;
      lobes.push({ x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8 + 0.04, r: 0.1 + rnd() * 0.09 });
    }
    const inside = (u, v) => lobes.some((l) => (u - l.x) ** 2 + (v - l.y) ** 2 < l.r * l.r);
    for (let i = 0, tries = 0; i < 420 && tries < 20000; tries++) {
      const u = (rnd() - 0.5) * 0.86, v = (rnd() - 0.5) * 0.86;
      if (!inside(u, v)) continue;
      i++;
      const depth = rnd(), rim = Math.min(1, Math.hypot(u, v) / 0.36);
      commands.push({
        kind: 'leaf', cx: s / 2 + u * s, cy: s / 2 + v * s, rx: 5 + rnd() * 4, ry: 2.2 + rnd() * 1.6,
        rot: rnd() * Math.PI, hue: 98 + rnd() * 18, sat: 30 + rnd() * 14, light: 11 + 15 * Math.max(depth, rim * 0.8),
      });
    }
    // in bloom the blossoms overlap into a near-solid mass over the top (spaced dots read
    // as polka dots), with leaves showing only toward the bottom and the edges
    for (let i = 0, tries = 0; i < 170 && tries < 20000; tries++) {
      const u = (rnd() - 0.5) * 0.8, v = (rnd() - 0.6) * 0.78;   // canvas y down: the upper part
      if (!inside(u, v)) continue;
      i++;
      commands.push({ kind: 'blossom', cx: s / 2 + u * s, cy: s / 2 + v * s, radius: 9 + rnd() * 6, rot: rnd() * Math.PI, shade: 0.72 + rnd() * 0.28 });
    }
    return commands;
  }
  throw new RangeError(`Unknown vegetation texture kind: ${kind}`);
}

// Pine-straw mat: a faint continuous brown disc (densest at the trunk, fading to
// nothing at the rim so it feathers into turf) with many short needle strokes on
// top for litter detail. The transparent gaps let blades of turf show through.
function strawTextureCanvas() {
  const s = 256, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  const base = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  // a light litter tint under the crown, not an opaque disc (it read as a mulch ring on
  // open grass, round and tan, from the tee)
  base.addColorStop(0.0, 'rgba(124,78,40,0.42)');
  base.addColorStop(0.55, 'rgba(110,66,34,0.26)');
  base.addColorStop(1.0, 'rgba(110,66,34,0.0)');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  for (const command of vegetationTextureCommands('straw')) {
    ctx.strokeStyle = command.color;
    ctx.globalAlpha = command.alpha;
    ctx.lineWidth = command.lineWidth;
    ctx.beginPath();
    ctx.moveTo(command.cx, command.cy);
    ctx.lineTo(command.x2, command.y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return cv;
}

function strawTexture() {
  const t = new THREE.CanvasTexture(strawTextureCanvas());
  t.anisotropy = 4;
  return t;
}

// treeSpots: [{x,y,s}] (on-course trees only — not the horizon band), hAt, V.
// One flat straw mat per trunk; overlapping mats in a wooded clump read as a
// continuous carpet, an isolated fairway tree gets a tidy mulch ring.
export function buildPineStraw(treeSpots, hAt, V) {
  if (!treeSpots.length) return { meshes: [] };
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); // lie flat, y up
  const mat = new THREE.MeshStandardMaterial({
    map: strawTexture(), transparent: true, roughness: 1.0, metalness: 0,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, treeSpots.length);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 2; // after the grounding contact-shadow (renderOrder 1)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
  const base = RENDER_CONFIG.treeScale || 1.0;
  for (let i = 0; i < treeSpots.length; i++) {
    const sp = treeSpots[i];
    const h = hAt(sp.x, sp.y);
    q.setFromAxisAngle(up, (i * 2.39996) % (Math.PI * 2)); // golden-angle spin, no shared seam
    const d = base * (sp.s || 1) * (4.0 + (i % 3)); // 4-6m, varied so rings don't tile
    sc.set(d, 1, d);
    m4.compose(V(sp.x, sp.y, h + 0.06), q, sc); // just above the contact-shadow decal
    mesh.setMatrixAt(i, m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return { meshes: [mesh] };
}

// --- azalea-style flowering bushes ----------------------------------------

// An azalea clump (camera-facing in buildFlowers): small dark leaves in an irregular
// mass with five-petalled blossoms crowded over its top, white so the bush's colour
// tints them (the shader's bloom mask), on a transparent ground. Alpha-tested.
function flowerTextureCanvas() {
  const s = 256, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  for (const c of vegetationTextureCommands('flower')) {
    if (c.kind === 'leaf') {
      ctx.fillStyle = `hsl(${c.hue.toFixed(1)},${c.sat.toFixed(1)}%,${c.light.toFixed(1)}%)`;
      ctx.beginPath(); ctx.ellipse(c.cx, c.cy, c.rx, c.ry, c.rot, 0, Math.PI * 2); ctx.fill();
    } else {
      const v = Math.round(255 * c.shade);
      for (let k = 0; k < 5; k++) {
        const a = c.rot + (k / 5) * Math.PI * 2, pr = c.radius * 0.42;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.beginPath(); ctx.arc(c.cx + Math.cos(a) * pr, c.cy + Math.sin(a) * pr, c.radius * 0.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgb(${Math.round(v * 0.72)},${Math.round(v * 0.7)},${Math.round(v * 0.7)})`;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, c.radius * 0.22, 0, Math.PI * 2); ctx.fill();
    }
  }
  return cv;
}

function flowerTexture() {
  const t = new THREE.CanvasTexture(flowerTextureCanvas());
  t.anisotropy = 4;
  return t;
}

async function canvasPixelChecksum(canvas) {
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const digest = await crypto.subtle.digest('SHA-256', pixels);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Capture-only test seam. The production texture constructors above use these
// exact Canvas2D builders; constructing each twice proves the rasterized RGBA
// output, not merely the seeded command stream, is stable in the real browser.
export async function vegetationTexturePixelChecksums() {
  const [strawA, strawB, flowerA, flowerB] = await Promise.all([
    canvasPixelChecksum(strawTextureCanvas()),
    canvasPixelChecksum(strawTextureCanvas()),
    canvasPixelChecksum(flowerTextureCanvas()),
    canvasPixelChecksum(flowerTextureCanvas()),
  ]);
  return {
    straw: { a: strawA, b: strawB, stable: strawA === strawB },
    flower: { a: flowerA, b: flowerB, stable: flowerA === flowerB },
  };
}

// A bush: nine clumps that turn to face the camera (trees.js BILLBOARD_*), heaped in
// a low dome ~1.4 m across, each with a normal out of the dome so it lights as one
// soft mass (the crossed flat cards it replaces read as paper cut-outs).
function bushGeometry() {
  const rnd = deterministicRandom(0xb05);
  // a heaped dome, its lowest clumps sitting on the ground
  const clumps = [[0, 0.62, 0, 0.95], [0, 0.4, 0, 1.0]];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rnd() * 0.6, d = 0.3 + rnd() * 0.2;
    clumps.push([Math.cos(a) * d, 0.3 + rnd() * 0.15, Math.sin(a) * d, 0.72 + rnd() * 0.2]);
  }
  const pos = [], nor = [], uv = [], corner = [], idx = [];
  let v = 0;
  for (const [x, y, z, size] of clumps) {
    const n = [x, y + 0.5, z], l = Math.hypot(...n);
    const roll = rnd() * Math.PI * 2, cr = Math.cos(roll), sr = Math.sin(roll), h = size / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(x, y, z);
      nor.push(n[0] / l, n[1] / l, n[2] / l);
      uv.push(sx * 0.5 + 0.5, sy * 0.5 + 0.5);
      corner.push((sx * cr - sy * sr) * h, (sx * sr + sy * cr) * h);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setIndex(idx);
  return g;
}

// Augusta-ish azalea palette: vivid hot-pink/magenta/red dominate so the beds
// read as colour at distance (pale blossoms just pick up the bluish aerial fog).
// No white: on the leafy clump bushes a white bed read as cotton wool.
const AZALEA = [0xc8467e, 0xa83a6e, 0xc04a5c, 0xd06a95, 0xb4517f, 0xd982a8];

// spots: [{x,y,s}], hAt, V. One instanced mesh of crossed-quad bushes, each
// tinted to a random azalea color. Returns { meshes }.
export function buildFlowers(spots, hAt, V) {
  if (!spots.length) return { meshes: [] };
  const mat = new THREE.MeshStandardMaterial({
    map: flowerTexture(), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.9, metalness: 0, envMapIntensity: 0.6,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCorner;')
      .replace('#include <defaultnormal_vertex>', BILLBOARD_NORMAL)
      .replace('#include <project_vertex>', `${BILLBOARD_PROJECT}
        {
          // nothing in front of the shot: a bush ahead of the camera across the middle
          // of the view (within 35 m), or right beside it, is not drawn
          vec3 fv = (modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
          float depth = -fv.z;
          bool ahead = abs(fv.x) < 2.5 + 0.08 * max(depth, 0.0) && depth > -1.0 && depth < 35.0;
          if (ahead || length(fv.xz) < 6.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        }`)
      .replace('#include <worldpos_vertex>', BILLBOARD_WORLDPOS);
    // the bush's colour tints its blossoms (white in the texture) and leaves its leaves green
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', `
      #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        // by brightness, not whiteness: at a distance the blossoms' mips blend with the dark
        // leaves into a mid tone that a whiteness mask missed, and far beds went grey
        float bloom = smoothstep(0.18, 0.5, dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vColor.rgb, bloom);
      #endif`)
      // a clump's normal comes from the dome, not the card: a back-facing card must not
      // flip it inward
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal); nonPerturbedNormal = normal;`);
  };
  mat.customProgramCacheKey = () => 'azalea-v4-clumps';
  const mesh = new THREE.InstancedMesh(bushGeometry(), mat, spots.length);
  mesh.frustumCulled = false;   // instances spread over the course; the bound is one bush
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.userData.isFlowers = true; // probe/debug hook
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), col = new THREE.Color();
  const rnd = deterministicRandom(91);
  for (let i = 0; i < spots.length; i++) {
    const sp = spots[i];
    const h = hAt(sp.x, sp.y);
    q.setFromAxisAngle(up, rnd() * Math.PI * 2);
    const sz = 0.75 + rnd() * 0.5;
    sc.set(sz * (sp.s || 1), sz * (0.85 + rnd() * 0.4) * (sp.s || 1), sz * (sp.s || 1));
    m4.compose(V(sp.x, sp.y, h - 0.12), q, sc);   // set into the ground a little: a bush has no visible foot
    mesh.setMatrixAt(i, m4);
    col.setHex(AZALEA[(rnd() * AZALEA.length) | 0]);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return { meshes: [mesh] };
}
