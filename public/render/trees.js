// Instanced 3D trees with three levels of detail, replacing the flat card trees.
//
// Each species is a small procedural recipe: a tapered, slightly bent trunk, a few
// branches, and a canopy of CLUMPS. Near trees draw every clump as a shell of
// leaf cards whose normals point out of the clump centre (so the whole canopy is lit
// like a soft volume — the classic fix for "cardboard" foliage) around a darker
// solid core; mid trees draw the clumps as noise-displaced solid blobs; far trees a
// cheaper blob of the same silhouette. Leaf/needle textures are drawn procedurally
// on a canvas at load (no downloads); bark reuses the bundled CC0 bark photo.
//
// One TreeField owns every tree on the course. Each frame it re-buckets instances
// into near / mid / far by camera distance and drops trees outside a widened view
// frustum (keeping everything within 70 m so off-screen trees still cast shadows
// into view). Instance matrices are composed once; bucketing is a memcpy.
// Wind: a trunk-rooted sway that grows with height plus a faster leaf flutter, in
// the vertex shader of every part (and of the shadow depth pass).
import * as THREE from 'three';
import { ASSETS } from './assets.js';
import { RENDER_CONFIG } from './config.js';
import { coverageMipChain } from './alpha-mips.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- leaf atlas
// 1024^2 canvas, 2x2 tiles: [0] broadleaf cluster, [1] small-leaf (birch) cluster,
// [2] fir needle spray, [3] pine needle tuft. Colour is OPAQUE (background = the
// tile's mid leaf colour so mipmaps don't fringe dark); coverage lives in a separate
// alpha canvas used as alphaMap.
let ATLAS = null;
function leafAtlas() {
  if (ATLAS) return ATLAS;
  const S = 1024, T = S / 2;
  const col = document.createElement('canvas'); col.width = col.height = S;
  const alp = document.createElement('canvas'); alp.width = alp.height = S;
  const c = col.getContext('2d'), a = alp.getContext('2d');
  a.fillStyle = '#000'; a.fillRect(0, 0, S, S);
  const r = rng(424242);
  const hsl = (h, s, l) => `hsl(${h},${s}%,${l}%)`;
  const tile = (k) => ({ x: (k % 2) * T, y: Math.floor(k / 2) * T });
  const both = (fn) => { fn(c, false); fn(a, true); };

  // broadleaf clusters (tiles 0 and 1)
  [[0, 95, 34, 30, 11, 21, 1.0], [1, 76, 48, 36, 8, 14, 0.85]].forEach(([k, hue, sat, light, lw, lh, spread]) => {
    const { x: ox, y: oy } = tile(k);
    c.fillStyle = hsl(hue, sat, light); c.fillRect(ox, oy, T, T);
    const cx = ox + T / 2, cy = oy + T / 2, R = T * 0.44 * spread;
    // twigs
    for (let i = 0; i < 9; i++) {
      const ang = r() * Math.PI * 2, len = R * (0.5 + r() * 0.5);
      both((g, isA) => {
        g.strokeStyle = isA ? '#fff' : '#4a3b2a'; g.lineWidth = isA ? 3 : 2.5;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len); g.stroke();
      });
    }
    const n = k === 0 ? 150 : 210;
    for (let i = 0; i < n; i++) {
      const rr = R * Math.sqrt(r()), th = r() * Math.PI * 2;
      const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
      const rot = th + (r() - 0.5) * 1.6;
      const w = lw * (0.75 + r() * 0.6) * 1.6, h = lh * (0.75 + r() * 0.5) * 1.6;
      const L = light + (r() - 0.5) * 18 + (1 - rr / R) * -6;     // darker toward the core
      const H = hue + (r() - 0.5) * 16;
      both((g, isA) => {
        g.save(); g.translate(x, y); g.rotate(rot);
        g.fillStyle = isA ? '#fff' : hsl(H, sat + (r() - 0.5) * 10, Math.max(8, L));
        g.beginPath(); g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); g.fill();
        if (!isA) { g.strokeStyle = hsl(H, sat, Math.max(6, L - 10)); g.lineWidth = 1; g.beginPath(); g.moveTo(-w / 2, 0); g.lineTo(w / 2, 0); g.stroke(); }
        g.restore();
      });
    }
  });

  // needle sprays (tiles 2 fir, 3 pine)
  [[2, 135, 30, 22, 10, 1.9], [3, 110, 28, 27, 16, 1.6]].forEach(([k, hue, sat, light, nl, nw]) => {
    const { x: ox, y: oy } = tile(k);
    c.fillStyle = hsl(hue, sat, light); c.fillRect(ox, oy, T, T);
    const twigs = k === 2 ? 7 : 9;
    for (let t = 0; t < twigs; t++) {
      // a twig from near the bottom-centre fanning upward
      const bx = ox + T * (0.3 + r() * 0.4), by = oy + T * (0.86 + r() * 0.08);
      const ang = -Math.PI / 2 + (r() - 0.5) * 1.5, len = T * (0.45 + r() * 0.35);
      const ex = bx + Math.cos(ang) * len, ey = by + Math.sin(ang) * len;
      both((g, isA) => { g.strokeStyle = isA ? '#fff' : '#3d3125'; g.lineWidth = isA ? 3 : 2; g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke(); });
      const steps = Math.round(len / 4);
      for (let s = 2; s < steps; s++) {
        const f = s / steps, px = bx + (ex - bx) * f, py = by + (ey - by) * f;
        for (const side of [-1, 1]) {
          const na = ang + side * (0.75 + r() * 0.35) - 0.25 * side * f;
          const L = nl * (0.75 + r() * 0.5) * (1.15 - f * 0.4);
          const LL = light + (r() - 0.5) * 14;
          both((g, isA) => {
            g.strokeStyle = isA ? '#fff' : hsl(hue + (r() - 0.5) * 12, sat, Math.max(7, LL));
            g.lineWidth = nw * (isA ? 1.25 : 1); g.beginPath(); g.moveTo(px, py);
            g.lineTo(px + Math.cos(na) * L, py + Math.sin(na) * L); g.stroke();
          });
        }
      }
    }
  });

  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  // coverage-preserving mip chain for the cutout (alpha-mips.js) so distant canopies
  // neither dissolve nor turn into opaque card shards. Rows flipped bottom-up to
  // match the CanvasTexture (flipY) UV convention of the colour map.
  const src = a.getImageData(0, 0, S, S).data;
  const a0 = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) a0[(S - 1 - y) * S + x] = src[(y * S + x) * 4];
  const chain = coverageMipChain(a0, S, S, { tiles: 2, cutoff: 128 });
  const toRGBA = (lvl) => {
    const d = new Uint8Array(lvl.w * lvl.h * 4);
    for (let i = 0; i < lvl.w * lvl.h; i++) { const v = lvl.alpha[i]; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    return { data: d, width: lvl.w, height: lvl.h };
  };
  const levels = chain.map(toRGBA);
  const alphaMap = new THREE.DataTexture(levels[0].data, S, S, THREE.RGBAFormat);
  alphaMap.mipmaps = levels;
  alphaMap.generateMipmaps = false;
  alphaMap.minFilter = THREE.LinearMipmapLinearFilter;
  alphaMap.magFilter = THREE.LinearFilter;
  alphaMap.colorSpace = THREE.NoColorSpace;
  alphaMap.anisotropy = 4;
  alphaMap.needsUpdate = true;
  ATLAS = { map, alphaMap };
  return ATLAS;
}
const TILE_UV = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]]; // (u0, v0) of each tile (v up)

// ---------------------------------------------------------------- recipes
// Clumps are { c: [x,y,z], r, sy } (sy = vertical squash). Heights in metres for a
// scale-1 tree; instances scale ~0.7-1.6.
const RECIPES = {
  oak: {
    H: 13, trunk: { h: 6.2, r0: 0.38, r1: 0.16, lean: 0.25 }, tile: 0, cards: 34, cardScale: 1.15,
    leaf: '#55722f', bark: '#6b5a49', branchR: 0.11,
    clumps: (r) => {
      const out = [{ c: [0, 8.8, 0], r: 3.6, sy: 0.82 }, { c: [0, 11.2, 0], r: 2.7, sy: 0.85 }];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + r() * 0.5, d = 2.8 + r() * 0.9;
        out.push({ c: [Math.cos(a) * d, 7.2 + r() * 2.4, Math.sin(a) * d], r: 2.5 + r() * 0.8, sy: 0.78 });
      }
      return out;
    },
  },
  pine: {
    H: 15, trunk: { h: 11.5, r0: 0.30, r1: 0.12, lean: 0.7 }, tile: 3, cards: 26, cardScale: 1.1,
    leaf: '#45603a', bark: '#8a5a3c', branchR: 0.08,
    clumps: (r) => {
      const out = [{ c: [0.6, 13.4, 0.2], r: 2.6, sy: 0.55 }];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + r() * 0.6, d = 1.8 + r() * 1.4;
        out.push({ c: [Math.cos(a) * d + 0.4, 10.6 + r() * 2.6, Math.sin(a) * d], r: 1.9 + r() * 0.8, sy: 0.5 });
      }
      return out;
    },
  },
  fir: {
    H: 14, trunk: { h: 6, r0: 0.30, r1: 0.10, lean: 0.08 }, tile: 2, cards: 16, cardScale: 1.3,
    leaf: '#35523a', bark: '#4e3e32', branchR: 0,
    clumps: (r) => {
      // overlapping tiers so the cone reads as one tree, not a stack of discs
      const out = [];
      const n = 11;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        out.push({ c: [(r() - 0.5) * 0.3, 1.6 + t * 11.8, (r() - 0.5) * 0.3], r: 3.2 * Math.pow(1 - t, 0.9) + 0.65, sy: 0.85 });
      }
      return out;
    },
  },
  birch: {
    H: 11, trunk: { h: 8.5, r0: 0.17, r1: 0.06, lean: 0.45 }, tile: 1, cards: 24, cardScale: 1.05,
    leaf: '#7e9b48', bark: '#d9d4c8', branchR: 0.05,
    clumps: (r) => {
      const out = [{ c: [0.3, 9.4, 0], r: 2.0, sy: 0.9 }];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + r() * 0.7, d = 1.2 + r() * 0.8;
        out.push({ c: [Math.cos(a) * d + 0.2, 6.6 + r() * 2.4, Math.sin(a) * d], r: 1.5 + r() * 0.6, sy: 0.85 });
      }
      return out;
    },
  },
};

// tapered, gently bent trunk (+ branches to the clump centres for broadleaves)
function trunkGeometry(rec, clumps, segs, withBranches) {
  const { h, r0, r1, lean } = rec.trunk;
  const parts = [];
  const g = new THREE.CylinderGeometry(r1, r0, h, segs, 5, false);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), f = y / h;
    p.setX(i, p.getX(i) + lean * f * f);
  }
  parts.push(g);
  if (withBranches && rec.branchR > 0) {
    const top = new THREE.Vector3(lean, h * 0.92, 0);
    for (const cl of clumps) {
      const end = new THREE.Vector3(cl.c[0] * 0.7, cl.c[1] - cl.r * 0.35, cl.c[2] * 0.7);
      const start = new THREE.Vector3(lean * 0.6, Math.min(h * 0.8, end.y - 1.2), 0);
      if (end.distanceTo(start) < 1.2) continue;
      const len = end.distanceTo(start);
      const bg = new THREE.CylinderGeometry(rec.branchR * 0.55, rec.branchR, len, 4, 1, true);
      bg.translate(0, len / 2, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
      bg.applyQuaternion(q); bg.translate(start.x, start.y, start.z);
      parts.push(bg.index ? bg.toNonIndexed() : bg);
      void top;
    }
  }
  return mergeGeoms(parts.map((x) => (x.index ? x.toNonIndexed() : x)));
}

function mergeGeoms(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// Leaf-card shell over every clump. Normals = out of the clump centre (soft volume
// lighting); aAO = 0 deep in the clump -> 1 at its surface.
function cardsGeometry(rec, clumps, r) {
  const pos = [], nor = [], uv = [], ao = [], idx = [];
  const [u0, v0] = TILE_UV[rec.tile];
  const up = new THREE.Vector3(0, 1, 0);
  let v = 0;
  for (const cl of clumps) {
    const C = new THREE.Vector3(...cl.c);
    const n = Math.round(rec.cards * (0.6 + 0.4 * cl.r / 3));
    for (let k = 0; k < n; k++) {
      // point in the clump, biased toward its surface
      const th = r() * Math.PI * 2, z = r() * 2 - 1, rr = Math.sqrt(1 - z * z);
      const dir = new THREE.Vector3(rr * Math.cos(th), z, rr * Math.sin(th));
      const depth = 0.45 + 0.55 * Math.sqrt(r());
      const P = C.clone().add(new THREE.Vector3(dir.x * cl.r * depth, dir.y * cl.r * cl.sy * depth, dir.z * cl.r * depth));
      // card faces roughly outward, randomly rolled
      const nrm = dir.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(1.2)).normalize();
      const t1 = new THREE.Vector3().crossVectors(nrm, Math.abs(nrm.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize();
      const t2 = new THREE.Vector3().crossVectors(nrm, t1).normalize();
      const roll = r() * Math.PI * 2, cr = Math.cos(roll), sr = Math.sin(roll);
      const A = t1.clone().multiplyScalar(cr).addScaledVector(t2, sr);
      const B = t1.clone().multiplyScalar(-sr).addScaledVector(t2, cr);
      const size = cl.r * rec.cardScale * (0.75 + r() * 0.45);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [cx, cy] of corners) {
        const Q = P.clone().addScaledVector(A, cx * size * 0.5).addScaledVector(B, cy * size * 0.5);
        pos.push(Q.x, Q.y, Q.z);
        const sN = Q.clone().sub(C); sN.y /= Math.max(0.3, cl.sy); sN.normalize();
        const N = sN.multiplyScalar(0.85).addScaledVector(up, 0.25).normalize();
        nor.push(N.x, N.y, N.z);
        uv.push(u0 + (cx * 0.5 + 0.5) * 0.5, v0 + (cy * 0.5 + 0.5) * 0.5);
        const d = Q.clone().sub(C); d.y /= Math.max(0.3, cl.sy);
        ao.push(Math.min(1, d.length() / cl.r));
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g.setIndex(idx);
  return g;
}

// Solid canopy blobs: noise-displaced icospheres per clump, spherical normals.
function blobGeometry(clumps, detail, scale, r) {
  const parts = [];
  for (const cl of clumps) {
    const g = new THREE.IcosahedronGeometry(1, detail);   // polyhedra are already non-indexed
    const p = g.attributes.position;
    const ph = r() * 10;
    const nrm = new Float32Array(p.count * 3), ao = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const bump = 1 + 0.16 * Math.sin(x * 3.1 + ph) * Math.sin(y * 2.7 - ph) * Math.sin(z * 3.3 + ph * 0.5) + (r() - 0.5) * 0.08;
      const k = cl.r * scale * bump;
      p.setXYZ(i, cl.c[0] + x * k, cl.c[1] + y * k * cl.sy, cl.c[2] + z * k);
      const n = new THREE.Vector3(x, y / Math.max(0.3, cl.sy), z).normalize().multiplyScalar(0.85).add(new THREE.Vector3(0, 0.25, 0)).normalize();
      nrm[i * 3] = n.x; nrm[i * 3 + 1] = n.y; nrm[i * 3 + 2] = n.z;
      ao[i] = 1;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
    parts.push(g);
  }
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), ao = new Float32Array(n), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    ao.set(g.attributes.aAO.array, o);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  return out;
}

// ---------------------------------------------------------------- shaders
const WIND_VERT = /* glsl */`
  {
    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    float ph = ip.x * 0.043 + ip.z * 0.067;
    float hf = max(transformed.y - 1.5, 0.0) / uTreeH;
    float bend = hf * hf;
    float gust = 0.65 + 0.35 * sin(uTime * 0.31 + ph * 0.5);
    float sway = (sin(uTime * 1.25 + ph) * 0.6 + sin(uTime * 2.05 + ph * 1.7) * 0.4) * gust;
    transformed.x += sway * bend * uWindAmp;
    transformed.z += cos(uTime * 1.05 + ph * 1.3) * bend * uWindAmp * 0.55;
    #ifdef TREE_FLUTTER
    float fl = sin(uTime * 5.3 + dot(position, vec3(2.3, 1.7, 3.1)) + ph * 3.0);
    transformed += objectNormal * fl * 0.05 * hf;
    #endif
  }`;

function addTreeShader(mat, shared, { flutter = false, foliage = false, blob = false, key }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWindAmp = shared.uWindAmp;
    shader.uniforms.uTreeH = shared.uTreeH;
    shader.uniforms.uSunView = shared.uSunView;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${flutter ? '#define TREE_FLUTTER' : ''}
        uniform float uTime; uniform float uWindAmp; uniform float uTreeH;
        attribute float aAO;
        varying float vAO; varying float vTreeT; varying vec3 vObjP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAO = aAO; vTreeT = clamp(position.y / uTreeH, 0.0, 1.0); vObjP = position;
        ${WIND_VERT}`);
    if (foliage) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        // leaf cards carry canopy-volume normals (out of the clump): a back-facing card
        // must NOT flip them inward, or half the canopy shades black
        normal = normalize(vNormal); nonPerturbedNormal = normal;`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunView;
        varying float vAO; varying float vTreeT; varying vec3 vObjP;
        float tH(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float tN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(tH(i), tH(i+vec3(1,0,0)), f.x), mix(tH(i+vec3(0,1,0)), tH(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(tH(i+vec3(0,0,1)), tH(i+vec3(1,0,1)), f.x), mix(tH(i+vec3(0,1,1)), tH(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          ${foliage || blob ? `
          // canopy volume: dark, cool interior / underside -> bright, warm sunlit crown
          float occ = mix(0.42, 1.0, vAO) * mix(0.72, 1.08, vTreeT);
          diffuseColor.rgb *= occ * mix(vec3(0.86, 0.95, 0.90), vec3(1.06, 1.04, 0.90), vTreeT);` : ''}
          ${blob ? `
          // leafy mottling on the solid LODs (object space so it sways with the tree)
          float m = tN(vObjP * 1.9) * 0.6 + tN(vObjP * 4.3) * 0.4;
          diffuseColor.rgb *= 0.72 + 0.5 * m;` : ''}
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        ${foliage || blob ? `
        // foliage is a matte scatterer: the GGX Fresnel sheen at grazing angles lit
        // whole leaf cards sky-grey (the 'glass shard' look) — keep only a trace
        reflectedLight.indirectSpecular *= 0.12;
        reflectedLight.directSpecular *= 0.25;` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${foliage || blob ? `
        {
          // translucency: leaves glow when the camera looks toward the sun through them
          vec3 toCam = normalize(vViewPosition);
          float back = pow(clamp(dot(-toCam, uSunView), 0.0, 1.0), 5.0);
          totalEmissiveRadiance += diffuseColor.rgb * back * 0.55 * vAO;
        }` : ''}`);
  };
  mat.customProgramCacheKey = () => `tree3d-${key}`;
}

// depth material for shadows with the same wind (and alpha for leaf cards)
function makeDepthMat(shared, { alpha = false, atlas = null, flutter = false, key }) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (alpha) { m.alphaMap = atlas.alphaMap; m.alphaTest = 0.5; m.map = atlas.map; }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWindAmp = shared.uWindAmp;
    shader.uniforms.uTreeH = shared.uTreeH;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${flutter ? '#define TREE_FLUTTER' : ''}
        uniform float uTime; uniform float uWindAmp; uniform float uTreeH;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 objectNormal = vec3(normal);
        ${WIND_VERT}`);
  };
  m.customProgramCacheKey = () => `tree3d-depth-${key}`;
  return m;
}

// ---------------------------------------------------------------- the field
const LOD_MID_M = 1100;     // mid blob -> far blob switch (near = leaf cards, see nearM)
const FAR_CULL_M = 3200;    // fogged out past here
const KEEP_RADIUS_M = 70;   // always drawn (shadow casters just off-screen)

export class TreeField {
  // spots: [{x, y, s, species}] (sim metres); hAt(x,y) -> ground height; V: sim->three
  constructor(spots, hAt, V, { nearM = 150, sunDir = null } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'treeField';
    this.nearM = nearM;
    this.shared = {
      uTime: { value: 0 },
      uWindAmp: { value: 0.012 + (RENDER_CONFIG.windStrength ?? 0.5) * 0.03 },
      uTreeH: { value: 14 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
    };
    this._sunDir = sunDir || new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.species = [];
    this._disposables = [];
    const atlas = leafAtlas();
    const bark = new THREE.TextureLoader().load(ASSETS.trees.bark);
    bark.colorSpace = THREE.SRGBColorSpace;
    bark.wrapS = bark.wrapT = THREE.RepeatWrapping;
    this._disposables.push(bark);

    const bySpecies = {};
    for (const s of spots) (bySpecies[s.species || 'oak'] ||= []).push(s);
    let seed = 99;
    for (const [name, list] of Object.entries(bySpecies)) {
      const rec = RECIPES[name] || RECIPES.oak;
      const r = rng(seed += 101);
      const clumps = rec.clumps(r);
      const sharedSp = { ...this.shared, uTreeH: { value: rec.H } };
      // materials
      const leafCol = new THREE.Color(rec.leaf);
      // the atlas is already leaf-coloured: tint it toward the species hue, not multiply
      // green by green (which went near-black)
      const mx = Math.max(leafCol.r, leafCol.g, leafCol.b, 1e-4);
      const tint = new THREE.Color(1, 1, 1).lerp(new THREE.Color(leafCol.r / mx, leafCol.g / mx, leafCol.b / mx), 0.5);
      const cardMat = new THREE.MeshStandardMaterial({
        color: tint, map: atlas.map, alphaMap: atlas.alphaMap, alphaTest: 0.5, side: THREE.DoubleSide,
        roughness: 0.82, metalness: 0, envMapIntensity: 0.6,
      });
      addTreeShader(cardMat, sharedSp, { flutter: true, foliage: true, key: `${name}-cards` });
      const coreMat = new THREE.MeshStandardMaterial({ color: leafCol.clone().multiplyScalar(0.5), roughness: 0.95, metalness: 0, envMapIntensity: 0.4 });
      addTreeShader(coreMat, sharedSp, { blob: true, key: `${name}-core` });
      const blobMat = new THREE.MeshStandardMaterial({ color: leafCol.clone().multiplyScalar(0.8), roughness: 0.9, metalness: 0, envMapIntensity: 0.5 });
      addTreeShader(blobMat, sharedSp, { blob: true, key: `${name}-blob` });
      const trunkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(rec.bark), map: bark, roughness: 0.95, metalness: 0 });
      addTreeShader(trunkMat, sharedSp, { key: `${name}-trunk` });
      const depthCards = makeDepthMat(sharedSp, { alpha: true, atlas, flutter: true, key: `${name}-cards` });
      const depthSolid = makeDepthMat(sharedSp, { key: `${name}-solid` });
      // geometries per LOD
      const geo = {
        trunkNear: trunkGeometry(rec, clumps, 8, true),
        trunkMid: trunkGeometry(rec, clumps, 5, false),
        cards: cardsGeometry(rec, clumps, r),
        core: blobGeometry(clumps, 0, 0.47, r),   // shadowed interior mass behind the cards
        blobMid: blobGeometry(clumps, 1, 0.95, r),
        blobFar: blobGeometry(clumps, 0, 0.98, r),
      };
      // UVs on the trunk: wrap the bark photo a few times
      for (const g of [geo.trunkNear, geo.trunkMid]) {
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * 3);
      }
      const n = list.length;
      const mk = (g, m, depth) => {
        const im = new THREE.InstancedMesh(g, m, 0);   // shared per-LOD buffers assigned below
        im.frustumCulled = false;
        im.castShadow = true;
        im.receiveShadow = true;
        if (depth) im.customDepthMaterial = depth;
        this.group.add(im);
        this._disposables.push(g, m);
        return im;
      };
      const lods = [
        [mk(geo.trunkNear, trunkMat, depthSolid), mk(geo.core, coreMat, depthSolid), mk(geo.cards, cardMat, depthCards)],
        [mk(geo.trunkMid, trunkMat, depthSolid), mk(geo.blobMid, blobMat, depthSolid)],
        [mk(geo.blobFar, blobMat, depthSolid)],
      ];
      this._disposables.push(depthCards, depthSolid);
      // one shared instance buffer per LOD (uploaded once for all its parts)
      const buffers = lods.map((parts) => {
        const mat4 = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
        mat4.setUsage(THREE.DynamicDrawUsage);
        const col = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        col.setUsage(THREE.DynamicDrawUsage);
        for (const im of parts) { im.instanceMatrix = mat4; im.instanceColor = col; }
        return { mat4, col, parts, count: 0 };
      });
      // trunks keep their own colour (instance colour multiplies — keep it near white)
      // so give trunk meshes a separate neutral colour buffer per LOD
      for (const b of buffers.slice(0, 2)) {
        const neutral = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
        b.parts[0].instanceColor = neutral;
      }
      // compose every instance once
      const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), centers = new Float32Array(n * 4);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
      const rr = rng(seed * 7 + 3);
      for (let i = 0; i < n; i++) {
        const s0 = list[i];
        const h = hAt(s0.x, s0.y);
        const s = (RENDER_CONFIG.treeScale || 1) * (s0.s || 1);
        const w = s * (0.85 + rr() * 0.3), ht = s * (0.88 + rr() * 0.3);
        q.setFromAxisAngle(up, rr() * Math.PI * 2);
        sc.set(w, ht, w);
        const p = V(s0.x, s0.y, h - 0.15);
        m4.compose(p, q, sc);
        m4.toArray(mats, i * 16);
        // per-tree colour: brightness + a little hue drift (sun-scorched / lush)
        const b = 0.82 + rr() * 0.36, warm = (rr() - 0.5) * 0.12;
        c.setRGB(b * (1 + warm), b, b * (1 - warm * 1.4));
        cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
        centers[i * 4] = p.x; centers[i * 4 + 1] = p.y + rec.H * 0.5 * ht; centers[i * 4 + 2] = p.z;
        centers[i * 4 + 3] = rec.H * 0.6 * Math.max(w, ht) + 2;
      }
      this.species.push({ name, n, mats, cols, centers, buffers });
    }
    this._frustum = new THREE.Frustum();
    this._cullCam = new THREE.PerspectiveCamera();
    this._last = { pos: new THREE.Vector3(1e9, 0, 0), dir: new THREE.Vector3(), t: -1e9 };
    this._tmp = new THREE.Vector3();
    this.stats = { near: 0, mid: 0, far: 0 };
  }

  setNearDistance(m) { this.nearM = m; this._last.t = -1e9; }

  // Re-bucket instances for this camera (cheap; skipped when the camera is still).
  update(camera, timeSec = 0) {
    this.shared.uTime.value = timeSec;
    // sun direction in view space for leaf translucency
    this.shared.uSunView.value.copy(this._sunDir).transformDirection(camera.matrixWorldInverse);
    const dir = camera.getWorldDirection(this._tmp);
    const L = this._last;
    const now = performance.now();
    const moved = camera.position.distanceToSquared(L.pos) > 1.0 || dir.dot(L.dir) < 0.9997;
    if (!moved && now - L.t < 1000) return;
    L.pos.copy(camera.position); L.dir.copy(dir); L.t = now;
    // widened frustum so a frame of lag never shows a pop at the screen edge
    const cc = this._cullCam;
    cc.fov = Math.min(150, camera.fov * 1.35); cc.aspect = camera.aspect; cc.near = camera.near; cc.far = FAR_CULL_M;
    cc.updateProjectionMatrix();
    const pm = new THREE.Matrix4().multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(pm);
    const planes = this._frustum.planes;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const nearM = this.nearM;
    let nN = 0, nM = 0, nF = 0;
    for (const sp of this.species) {
      const { n, mats, cols, centers, buffers } = sp;
      const out = [0, 0, 0];
      const mA = buffers.map((b) => b.mat4.array), cA = buffers.map((b) => b.col.array);
      for (let i = 0; i < n; i++) {
        const x = centers[i * 4], y = centers[i * 4 + 1], z = centers[i * 4 + 2], R = centers[i * 4 + 3];
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > FAR_CULL_M) continue;
        if (d > KEEP_RADIUS_M) {
          let vis = true;
          for (let k = 0; k < 6; k++) {
            const pl = planes[k];
            if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -R) { vis = false; break; }
          }
          if (!vis) continue;
        }
        const lod = d < nearM ? 0 : d < LOD_MID_M ? 1 : 2;
        const j = out[lod]++;
        mA[lod].set(mats.subarray(i * 16, i * 16 + 16), j * 16);
        cA[lod].set(cols.subarray(i * 3, i * 3 + 3), j * 3);
      }
      buffers.forEach((b, lod) => {
        b.count = out[lod];
        for (const im of b.parts) im.count = out[lod];
        if (out[lod]) {
          b.mat4.clearUpdateRanges(); b.mat4.addUpdateRange(0, out[lod] * 16); b.mat4.needsUpdate = true;
          b.col.clearUpdateRanges(); b.col.addUpdateRange(0, out[lod] * 3); b.col.needsUpdate = true;
        }
      });
      nN += out[0]; nM += out[1]; nF += out[2];
    }
    this.stats = { near: nN, mid: nM, far: nF };
  }

  dispose() {
    for (const d of this._disposables) d?.dispose?.();
  }
}

export function treeAtlasForTest() { return leafAtlas(); }
