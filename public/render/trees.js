// Instanced 3D trees with three levels of detail.
//
// Every tree is a generated model (tree-gen.js): a real branch skeleton — space-
// colonized limbs for oak, maple and birch, whorled branches for spruce, a bare bole
// and needle tufts for pine — dressed in leaf / needle CARDS cut from photographed
// leaves (leaf-atlas.js). Each species has three models: two open-grown and one grown
// in closed woods (higher crown, narrower), so neighbours never repeat and a woods
// edge reads differently from a lone fairway oak. Card normals point out of the
// crown (so it lights as one soft volume — the classic fix for "cardboard" foliage)
// and darken toward its core.
//
// The far levels of detail are the SAME model with fewer, larger cards and only the
// main limbs, so a tree keeps its silhouette — gaps, lobes, sky between limbs — all
// the way to the horizon instead of turning into a solid blob (the "lollipop").
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
import { realTreeSize } from './tree-placement.js';
import { generateTree, thinCards } from './tree-gen.js';
import { leafAtlas, birchBark, ATLAS_TILE_UV } from './leaf-atlas.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- models
const VARIANTS = 3;                 // [0], [1] open-grown, [2] grown in closed woods
const LOD_CARD_EVERY = [1, 4, 24];  // keep 1 in N leaf cards per level of detail (far: crossed triples)
const LOD_MIN_R = [0.02, 0.07, 0.16]; // thinnest bark tube drawn (m, at a 16 m tree)
const LOD_SIDES = [6, 4, 3];

// Leaf tint multiplies the photographed atlas; bark texture + tint per species.
const LOOK = {
  oak: { leaf: '#5d7f33', bark: 'oak', barkTint: '#a09484' },
  maple: { leaf: '#557d35', bark: 'oak', barkTint: '#948a80' },
  birch: { leaf: '#7f9e45', bark: 'birch', barkTint: '#ffffff' },
  pine: { leaf: '#5f7d48', bark: 'pine', barkTint: '#b49078' },
  fir: { leaf: '#4f7151', bark: 'spruce', barkTint: '#8c7864' },
};

const MODELS = new Map();
function model(species, v) {
  const key = `${species}:${v}`;
  if (!MODELS.has(key)) MODELS.set(key, generateTree(species, 1009 + v * 7 + species.length * 131, { forest: v === 2 }));
  return MODELS.get(key);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Bark: one tapered tube per branch segment (segments thinner than the level's
// cut-off are hidden in the foliage anyway).
function barkGeometry(m, lod) {
  const minR = LOD_MIN_R[lod] * (m.H / 16);
  const pos = [], nor = [], uv = [];
  for (const s of m.branches) {
    if (s.ra < minR) continue;
    // The far level keeps the trunk below the crown, three-sided: the limbs inside a crown
    // a few dozen pixels tall are hidden by its leaf cards, and they were most of its
    // triangles (at Low, 195k of the 447k the far trees drew from Hazeltine's 1st tee).
    if (lod === 2 && Math.min(s.a[1], s.b[1]) > m.crownBase) continue;
    const ax = sub(s.b, s.a);
    const L = Math.hypot(ax[0], ax[1], ax[2]);
    if (L < 1e-3) continue;
    const d = [ax[0] / L, ax[1] / L, ax[2] / L];
    const t1 = nrm(cross(d, Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]));
    const t2 = cross(d, t1);
    const n = LOD_SIDES[lod] + (lod < 2 && s.ra > 0.15 ? 2 : 0);
    // overlap the ends a little so forks never show a seam
    const ea = Math.min(0.06, s.ra * 0.5), eb = Math.min(0.04, s.rb * 0.5);
    const A = [s.a[0] - d[0] * ea, s.a[1] - d[1] * ea, s.a[2] - d[2] * ea];
    const B = [s.b[0] + d[0] * eb, s.b[1] + d[1] * eb, s.b[2] + d[2] * eb];
    const uRep = Math.max(1, Math.round((2 * Math.PI * s.ra) / 0.45));
    const vB = (L + ea + eb) / 0.9;
    const ring = (k) => {
      const th = (k / n) * Math.PI * 2;
      return [t1[0] * Math.cos(th) + t2[0] * Math.sin(th), t1[1] * Math.cos(th) + t2[1] * Math.sin(th), t1[2] * Math.cos(th) + t2[2] * Math.sin(th)];
    };
    for (let k = 0; k < n; k++) {
      const e0 = ring(k), e1 = ring(k + 1);
      const P = [
        [A[0] + e0[0] * s.ra, A[1] + e0[1] * s.ra, A[2] + e0[2] * s.ra],
        [B[0] + e0[0] * s.rb, B[1] + e0[1] * s.rb, B[2] + e0[2] * s.rb],
        [B[0] + e1[0] * s.rb, B[1] + e1[1] * s.rb, B[2] + e1[2] * s.rb],
        [A[0] + e1[0] * s.ra, A[1] + e1[1] * s.ra, A[2] + e1[2] * s.ra],
      ];
      const N = [e0, e0, e1, e1];
      const U = [[(k / n) * uRep, 0], [(k / n) * uRep, vB], [((k + 1) / n) * uRep, vB], [((k + 1) / n) * uRep, 0]];
      // wind each quad so its face points out of the tube
      const fn = cross(sub(P[1], P[0]), sub(P[2], P[0]));
      const out = fn[0] * (e0[0] + e1[0]) + fn[1] * (e0[1] + e1[1]) + fn[2] * (e0[2] + e1[2]) > 0;
      const order = out ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const i of order) { pos.push(...P[i]); nor.push(...N[i]); uv.push(...U[i]); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(0.55), 1));
  return g;
}

// Leaf cards. Normals = out of the crown (broadleaves: from the crown's centre;
// conifers: out from the trunk, tipped up), aAO = 0 deep in the crown -> 1 outside.
function cardGeometry(m, cards) {
  const pos = [], nor = [], uv = [], ao = [], idx = [];
  const [cx, cy, cz] = m.center, [rx, ry] = m.radii;
  const lean = m.lean || [0, 0, 0];
  let v = 0;
  for (const c of cards) {
    const [u0, v0] = ATLAS_TILE_UV[c.tile];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const Q = [c.p[0] + c.right[0] * sx + c.up[0] * sy, c.p[1] + c.right[1] * sx + c.up[1] * sy, c.p[2] + c.right[2] * sx + c.up[2] * sy];
      pos.push(...Q);
      let N;
      if (m.normals === 'crown') {
        const d = nrm([(Q[0] - cx) / rx, (Q[1] - cy) / ry, (Q[2] - cz) / rx]);
        N = nrm([d[0] * 0.85, d[1] * 0.85 + 0.3, d[2] * 0.85]);
      } else {
        const f = (Q[1] / m.H) ** 2;
        const h = [Q[0] - lean[0] * f, 0, Q[2] - lean[2] * f];
        const hl = Math.hypot(h[0], h[2]);
        N = hl > 1e-3 ? nrm([h[0] / hl * 0.75, 0.5, h[2] / hl * 0.75]) : [0, 1, 0];
      }
      nor.push(...N);
      uv.push(u0 + (sx * 0.5 + 0.5) * 0.5, v0 + (sy * 0.5 + 0.5) * 0.5);
      ao.push(c.ao);
    }
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g.setIndex(idx);
  return g;
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

// A tree in front of the camera is drawn see-through: dithered to FADE_SHOWN of its
// pixels (no sorting; it still casts its shadow and still stops a ball). In front means
// ahead of the camera across the middle of the view, within uFadeNear metres (a cone a
// crown wide that widens with distance: the ball and the shot are in the middle of the
// frame), or within uFadeHug metres of the camera anywhere it looks. Per tree, from the
// instance's foot in view space, so a tree fades whole.
const FADE_NEAR_M = 45;
const FADE_HUG_M = 9;
const FADE_SHOWN = 0.12;
const FADE_VERT = /* glsl */`
  {
    float treeH = length(instanceMatrix[1].xyz) * uTreeH;
    // the tree's foot (its instance origin) in view space: camera at 0, looking down -z
    vec3 fv = (modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    float depth = -fv.z;
    float halfW = 0.3 * treeH + 1.0 + 0.06 * max(depth, 0.0);
    float cone = (1.0 - smoothstep(halfW, halfW + 3.0, abs(fv.x)))
               * (1.0 - smoothstep(uFadeNear * 0.75, uFadeNear, depth)) * step(-1.0, depth);
    float hug = (1.0 - smoothstep(uFadeHug * 0.7, uFadeHug, length(fv.xz))) * step(-halfW, depth);
    vFade = uFadeOn * max(cone, hug);
  }`;
const FADE_FRAG = /* glsl */`
  if (vFade > 0.0) {
    vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
    const float B[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
    if ((B[int(q.x) + int(q.y) * 4] + 0.5) / 16.0 < vFade * (1.0 - ${FADE_SHOWN.toFixed(2)})) discard;
  }`;

function addTreeShader(mat, shared, { flutter = false, foliage = false, key }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeNear = shared.uFadeNear;
    shader.uniforms.uFadeHug = shared.uFadeHug;
    shader.uniforms.uFadeOn = shared.uFadeOn;
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWindAmp = shared.uWindAmp;
    shader.uniforms.uTreeH = shared.uTreeH;
    shader.uniforms.uSunView = shared.uSunView;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${flutter ? '#define TREE_FLUTTER' : ''}
        uniform float uTime; uniform float uWindAmp; uniform float uTreeH;
        uniform float uFadeNear; uniform float uFadeHug; uniform float uFadeOn;
        attribute float aAO;
        varying float vAO; varying float vTreeT; varying float vFade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAO = aAO; vTreeT = clamp(position.y / uTreeH, 0.0, 1.0);
        ${WIND_VERT}
        ${FADE_VERT}`);
    if (foliage) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        // leaf cards carry crown-volume normals (out of the crown): a back-facing card
        // must NOT flip them inward, or half the canopy shades black
        normal = normalize(vNormal); nonPerturbedNormal = normal;`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunView;
        varying float vAO; varying float vTreeT; varying float vFade;`)
      .replace('#include <clipping_planes_fragment>', `${FADE_FRAG}
        #include <clipping_planes_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          ${foliage ? `
          // crown volume: dark, cool interior / underside -> bright, warm sunlit top
          float occ = mix(0.38, 1.0, vAO) * mix(0.74, 1.06, vTreeT);
          diffuseColor.rgb *= occ * mix(vec3(0.86, 0.95, 0.92), vec3(1.05, 1.03, 0.92), vTreeT);` : `
          // bark under the crown sits in the canopy's shade
          diffuseColor.rgb *= mix(0.62, 1.0, vAO);`}
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        ${foliage ? `
        // foliage is a matte scatterer: the GGX Fresnel sheen at grazing angles lit
        // whole leaf cards sky-grey (the 'glass shard' look) — keep only a trace
        reflectedLight.indirectSpecular *= 0.12;
        reflectedLight.directSpecular *= 0.3;` : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        ${foliage ? `
        {
          // translucency: leaves glow when the camera looks toward the sun through them
          vec3 toCam = normalize(vViewPosition);
          float back = pow(clamp(dot(-toCam, uSunView), 0.0, 1.0), 5.0);
          totalEmissiveRadiance += diffuseColor.rgb * back * 0.55 * vAO;
        }` : ''}`);
  };
  mat.customProgramCacheKey = () => `tree3d-v3-fade-${key}`;
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
  m.customProgramCacheKey = () => `tree3d-v2-depth-${key}`;
  return m;
}

// ---------------------------------------------------------------- the field
const LOD_MID_M = 1100;     // mid -> far switch by default (near = full model, see nearM; quality.js treeMidM)
const FAR_CULL_M = 3200;    // fogged out past here
const KEEP_RADIUS_M = 70;   // always drawn (shadow casters just off-screen)

// Trees with this many others within 7 m grew in closed woods: they get the
// woods-grown model (high crown base, narrow crown) instead of an open-grown one.
const WOODS_NEIGHBOURS = 3;
function crowdedness(spots) {
  const cell = 7, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  spots.forEach((s, i) => { const k = key(s.x, s.y); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  return spots.map((s) => {
    let n = 0;
    const cx = Math.floor(s.x / cell), cy = Math.floor(s.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cx + dx},${cy + dy}`) || []) {
        const o = spots[j];
        if (o !== s && (o.x - s.x) ** 2 + (o.y - s.y) ** 2 < 49) n++;
      }
    }
    return n;
  });
}

export class TreeField {
  // spots: [{x, y, s, species, h?, r?, edge?}] (sim metres); hAt(x,y) -> ground
  // height; V: sim->three
  constructor(spots, hAt, V, { nearM = 150, midM = LOD_MID_M, sunDir = null } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'treeField';
    this.nearM = nearM;
    this.midM = Math.max(nearM, midM ?? LOD_MID_M);
    this.shared = {
      uTime: { value: 0 },
      uWindAmp: { value: 0.012 + (RENDER_CONFIG.windStrength ?? 0.5) * 0.03 },
      uTreeH: { value: 14 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      // see-through trees (FADE_VERT): ahead of the camera across the middle of the view
      // within uFadeNear m, and any tree within uFadeHug m of it; uFadeOn 0 turns it off
      uFadeNear: { value: FADE_NEAR_M },
      uFadeHug: { value: FADE_HUG_M },
      uFadeOn: { value: 1 },
    };
    this._sunDir = sunDir || new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.variants = [];
    this._disposables = [];
    const atlas = leafAtlas();
    const loader = new THREE.TextureLoader();
    const barks = {};
    const barkTex = (kind) => {
      if (barks[kind]) return barks[kind];
      const t = kind === 'birch' ? birchBark()
        : loader.load(kind === 'oak' ? ASSETS.trees.oakBark : kind === 'pine' ? ASSETS.trees.pineBark : ASSETS.trees.bark);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this._disposables.push(t);
      return (barks[kind] = t);
    };

    const crowd = crowdedness(spots);
    const bySpecies = {};
    spots.forEach((s, i) => (bySpecies[s.species || 'oak'] ||= []).push({ s, crowd: crowd[i] }));
    let seed = 99;
    for (const [name, list] of Object.entries(bySpecies)) {
      const look = LOOK[name] || LOOK.oak;
      const species = LOOK[name] ? name : 'oak';
      const models = Array.from({ length: VARIANTS }, (_, v) => model(species, v));
      const sharedSp = { ...this.shared, uTreeH: { value: models[0].H } };
      // the atlas is already leaf-coloured: tint it toward the species hue, not
      // multiply green by green (which went near-black)
      const leafCol = new THREE.Color(look.leaf);
      const mx = Math.max(leafCol.r, leafCol.g, leafCol.b, 1e-4);
      const tint = new THREE.Color(1, 1, 1).lerp(new THREE.Color(leafCol.r / mx, leafCol.g / mx, leafCol.b / mx), 0.45).multiplyScalar(0.92);
      const cardMat = new THREE.MeshStandardMaterial({
        color: tint, map: atlas.map, alphaMap: atlas.alphaMap, alphaTest: 0.5, side: THREE.DoubleSide,
        roughness: 0.8, metalness: 0, envMapIntensity: 0.6,
      });
      addTreeShader(cardMat, sharedSp, { flutter: true, foliage: true, key: `${species}-cards` });
      const barkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(look.barkTint), map: barkTex(look.bark), roughness: 0.95, metalness: 0 });
      addTreeShader(barkMat, sharedSp, { key: `${species}-bark` });
      const depthCards = makeDepthMat(sharedSp, { alpha: true, atlas, flutter: true, key: `${species}-cards` });
      const depthBark = makeDepthMat(sharedSp, { key: `${species}-bark` });
      this._disposables.push(cardMat, barkMat, depthCards, depthBark);

      // which model each tree gets: woods-grown when crowded, else one of the open forms
      const perVariant = Array.from({ length: VARIANTS }, () => []);
      for (const { s, crowd: c } of list) {
        const v = c >= WOODS_NEIGHBOURS || s.edge === false ? 2 : (Math.abs(Math.floor(s.x * 7.13 + s.y * 3.71)) % 2);
        perVariant[v].push(s);
      }
      perVariant.forEach((vl, v) => {
        if (!vl.length) return;
        const m = models[v];
        const n = vl.length;
        // only the near LOD casts: mid/far trees sit outside the hole-fitted shadow
        // frustum anyway, and instanced meshes aren't light-frustum culled
        const mk = (g, mat, depth, cast) => {
          const im = new THREE.InstancedMesh(g, mat, 0);   // shared per-LOD buffers assigned below
          im.frustumCulled = false;
          im.castShadow = cast;
          im.receiveShadow = true;
          im.customDepthMaterial = depth;
          this.group.add(im);
          this._disposables.push(g);
          return im;
        };
        const lods = [0, 1, 2].map((lod) => [
          mk(barkGeometry(m, lod), barkMat, depthBark, lod === 0),
          mk(cardGeometry(m, thinCards(m.cards, LOD_CARD_EVERY[lod], 7 + v, { cross: lod === 2 })), cardMat, depthCards, lod === 0),
        ]);
        // one shared instance buffer per LOD (uploaded once for all its parts); bark
        // keeps a neutral colour buffer (instance colour multiplies)
        const buffers = lods.map((parts) => {
          const mat4 = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
          mat4.setUsage(THREE.DynamicDrawUsage);
          const col = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
          col.setUsage(THREE.DynamicDrawUsage);
          for (const im of parts) im.instanceMatrix = mat4;
          parts[1].instanceColor = col;
          parts[0].instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
          return { mat4, col, parts, count: 0 };
        });
        // compose every instance once
        const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), centers = new Float32Array(n * 4);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
        const rr = rng((seed += 101) * 7 + v);
        for (let i = 0; i < n; i++) {
          const s0 = vl[i];
          const h = hAt(s0.x, s0.y);
          let w, ht;
          if (s0.h > 0) {
            // a real tree (course.canopy): its measured height and crown radius
            ({ w, ht } = realTreeSize(s0, m.H, m.crownR, rr(), rr()));
          } else {
            const s = (RENDER_CONFIG.treeScale || 1) * (s0.s || 1) * 0.85;
            w = s * (0.85 + rr() * 0.3); ht = s * (0.88 + rr() * 0.3);
          }
          q.setFromAxisAngle(up, rr() * Math.PI * 2);
          sc.set(w, ht, w);
          const p = V(s0.x, s0.y, h - 0.15);
          m4.compose(p, q, sc);
          m4.toArray(mats, i * 16);
          // per-tree colour: brightness + a little hue drift (sun-scorched / lush)
          const b = 0.84 + rr() * 0.3, warm = (rr() - 0.5) * 0.07;
          c.setRGB(b * (1 + warm), b, b * (1 - warm * 1.4));
          cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
          centers[i * 4] = p.x; centers[i * 4 + 1] = p.y + m.H * 0.5 * ht; centers[i * 4 + 2] = p.z;
          centers[i * 4 + 3] = Math.max(m.H * 0.6 * ht, m.crownR * w) + 2;
        }
        this.variants.push({ name: species, v, n, mats, cols, centers, buffers });
      });
    }
    this._frustum = new THREE.Frustum();
    this._cullCam = new THREE.PerspectiveCamera();
    this._last = { pos: new THREE.Vector3(1e9, 0, 0), dir: new THREE.Vector3(), t: -1e9 };
    this._tmp = new THREE.Vector3();
    this.stats = { near: 0, mid: 0, far: 0 };
  }

  setNearDistance(m) { this.nearM = m; this._last.t = -1e9; }

  // Re-bucket instances for this camera (cheap; skipped when the camera is still).
  // Returns true when the per-LOD instance sets were rebuilt (the shadow casters may
  // have changed); false when the camera hasn't moved enough to matter.
  update(camera, timeSec = 0) {
    this.shared.uTime.value = timeSec;
    // sun direction in view space for leaf translucency
    this.shared.uSunView.value.copy(this._sunDir).transformDirection(camera.matrixWorldInverse);
    const dir = camera.getWorldDirection(this._tmp);
    const L = this._last;
    const now = performance.now();
    const moved = camera.position.distanceToSquared(L.pos) > 1.0 || dir.dot(L.dir) < 0.9997;
    if (!moved && now - L.t < 1000) return false;
    L.pos.copy(camera.position); L.dir.copy(dir); L.t = now;
    // widened frustum so a frame of lag never shows a pop at the screen edge
    const cc = this._cullCam;
    cc.fov = Math.min(150, camera.fov * 1.35); cc.aspect = camera.aspect; cc.near = camera.near; cc.far = FAR_CULL_M;
    cc.updateProjectionMatrix();
    const pm = new THREE.Matrix4().multiplyMatrices(cc.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(pm);
    const planes = this._frustum.planes;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const nearM = this.nearM, midM = this.midM;
    let nN = 0, nM = 0, nF = 0;
    for (const sp of this.variants) {
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
        const lod = d < nearM ? 0 : d < midM ? 1 : 2;
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
    return true;
  }

  dispose() {
    for (const d of this._disposables) d?.dispose?.();
  }
}

export function treeAtlasForTest() { return leafAtlas(); }
