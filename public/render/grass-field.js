// Near-camera grass: real blades on every mown and rough surface around the camera,
// so the ground at the ball, on a tee box or along a fairway edge reads as grass,
// not a texture — wherever the camera is (address, ball flight, free camera).
//
// GPU-placed: each ring draws a rect of blade clumps from a world-snapped grid (a
// clump's spot and look come from a hash of its world cell, so blades never swim as
// the rect moves). The rect is fitted every frame to the ground the camera can see,
// so the vertex work follows the view instead of a square around the camera. Each
// clump reads the same surface masks the turf shader uses — greens, sand and water
// get none; fairway and tees a short cut; rough a longer one — takes the turf's own
// base colour under it, and stands on the ground from a height texture sampled from
// scene.hAt (so lidar and HD terrain both match what the turf draws). Blades shrink
// to nothing toward a ring's reach (distance from the camera, height included), so
// the field ends without a line. Three rings: a dense one at the camera, the play
// ring, and the rough out to ~30 m (a mown cut is sub-pixel by then).
import * as THREE from 'three';
import { DIVOT_GLSL } from './divots.js';

// One clump: three tapered, slightly curved blades fanned around a point.
// position.y runs 0 (base) -> 1 (tip); x/z are metres at unit width.
function clumpGeometry() {
  const pos = [], idx = [];
  const blades = [[0, 0.012, 0.0], [2.1, 0.016, 0.35], [4.2, 0.01, -0.3]];
  let v = 0;
  for (const [ang, off, lean] of blades) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const ox = Math.cos(ang + 1.3) * off, oz = Math.sin(ang + 1.3) * off;
    // two segments still bend a short blade; the tip is one point (it tapers to
    // nothing anyway), so five vertices and three triangles a blade
    for (const t of [0, 0.5]) {
      const w = 0.0068 * (1 - 0.88 * t), bend = lean * t * t * 0.4;   // curls over toward the tip
      for (const side of [-1, 1]) pos.push(ox + c * w * side + s * bend, t, oz + s * w * side - c * bend);
    }
    pos.push(ox + s * lean * 0.4, 1, oz - c * lean * 0.4);
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2, v + 2, v + 3, v + 4);
    v += 5;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

const GRASS_VERT = /* glsl */`
  uniform float uTime, uSpacing, uGrid;
  uniform vec2 uOriginCell;              // world cell of the rect's (0, 0)
  uniform vec4 uBounds;                  // sim minX, minY, extX, extY of the masks
  uniform sampler2D uMown, uAux, uBase;  // turf masks + base colour (scene.js)
  uniform sampler2D uHeight;             // ground heights (R32F, nearest)
  uniform vec4 uHInfo;                   // sim minX, minY, cellM, (unused)
  uniform vec2 uHSize;                   // height texture size
  uniform vec2 uFade;                    // full size inside .x, gone by .y (m from camera)
  uniform vec2 uBladeH;                  // blade height (m): mown cut, rough
  varying vec3 vGrassCol;
  varying float vTip;
  varying vec3 vGrassW;   // world position (translucency view vector)
  vec2 gHash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  // world cell of this instance: the rect is uGrid cells wide, row by row
  vec2 gCell() {
    int w = int(uGrid);
    return uOriginCell + vec2(float(gl_InstanceID % w), float(gl_InstanceID / w));
  }
  float gGround(vec2 sim) {
    vec2 g = clamp((sim - uHInfo.xy) / uHInfo.z, vec2(0.0), uHSize - 1.001);
    ivec2 i = ivec2(floor(g));
    vec2 f = fract(g);
    float a = texelFetch(uHeight, i, 0).r, b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
    float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r, d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }${DIVOT_GLSL}`;

const GRASS_BEGIN = /* glsl */`
  vec3 transformed;
  {
    vec2 wc = gCell();
    vec2 hh = gHash(wc);
    vec2 sim = (wc + hh) * uSpacing;                       // jittered inside its cell
    float ground = gGround(sim);
    float fk = 1.0 - smoothstep(uFade.x, uFade.y, distance(cameraPosition, vec3(sim.x, ground, -sim.y)));
    float h = 0.0, cut = 1.0;
    vGrassCol = vec3(0.0);
    if (fk > 0.0) {                                        // past the reach nothing grows: skip the reads
      vec2 suv = (sim - uBounds.xy) / uBounds.zw;
      float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
      vec4 mown = texture2D(uMown, suv);                   // r: fairway/tee/green, g: green
      vec4 aux = texture2D(uAux, suv);                     // r: tee, g: water, b: bunker
      float bare = max(smoothstep(0.25, 0.6, mown.g), smoothstep(0.15, 0.45, max(aux.g, aux.b)));
      cut = smoothstep(0.35, 0.75, mown.r);
      h = mix(uBladeH.y, uBladeH.x, cut) * (0.65 + 0.7 * hh.x) * (1.0 - bare) * inside * fk;
      // no blades in a divot: the turf paints the scar there (divots.js)
      vec2 dvC; mat2 dvRot; vec2 dvR; float dvLook;
      if (h > 0.0 && cut > 0.5 && divotCell(sim - uBounds.xy, uBounds.zw, uMown, uAux, dvC, dvRot, dvR, dvLook))
        h *= step(1.0, divotE(sim - uBounds.xy, dvC, dvRot, dvR));
      // the turf's own base colour, one clump in seven a shade yellower (older blades)
      float older = step(0.86, fract(hh.x * 7.31 + hh.y * 3.17));
      vGrassCol = texture2D(uBase, suv).rgb * mix(vec3(1.0), vec3(1.25, 1.1, 0.62), older * 0.55) * (0.78 + 0.44 * hh.x);
    }
    float a = hh.y * 6.2831853;
    // a clump with no height collapses to a point: its triangles have no area to raster
    vec2 r = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xz * mix(1.4, 1.0, cut) * (0.55 + 0.45 * fk) * step(1e-4, h);
    float t = position.y;
    // wind: a slow gusting lean plus a little per-clump flutter, more on long blades
    float sway = (sin(uTime * 1.3 + sim.x * 0.21 + sim.y * 0.17) * 0.6 + sin(uTime * 2.9 + hh.x * 30.0) * 0.4) * (0.08 + 0.25 * (1.0 - cut));
    vec3 wp = vec3(sim.x + r.x, ground - 0.02 + t * h, -sim.y + r.y);
    wp.x += sway * t * t * h;
    wp.z += sway * 0.5 * t * t * h;
    transformed = wp;
    // dark deep in the clump (the blades shade each other), bright toward the lit tips,
    // so a blade reads against the ground it grows from instead of melting into it
    vGrassCol *= mix(0.38, 1.28, t);
    vTip = t;
    vGrassW = wp;
  }`;

function grassMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GRASS_VERT}`)
      // lit like the ground it grows from, but each clump leans its normal its own way
      // (from its cell's hash) so neighbouring clumps catch the sun differently: the
      // light/dark speckle that makes a field of blades read as grass, not paint
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal;
        {
          vec2 nh = gHash(gCell() + 17.0) - 0.5;
          objectNormal = normalize(vec3(nh.x * 0.9, 1.0, nh.y * 0.9));
        }`)
      .replace('#include <begin_vertex>', GRASS_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;\nvarying float vTip;\nvarying vec3 vGrassW;\nuniform vec3 uSunDir;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vGrassCol;')
      // backlit blades glow: looking toward the sun, light comes THROUGH the thin upper
      // blade (translucency), the cue that sells a field of grass against the light
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 toEye = normalize(cameraPosition - vGrassW);
          float back = pow(max(dot(-toEye, uSunDir), 0.0), 3.0);
          totalEmissiveRadiance += vGrassCol * (1.4 * back * vTip * vTip);
        }`)
      // a blade's back face must keep the up normal (DoubleSide flips it: black blades)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal); nonPerturbedNormal = normal;');
  };
  m.customProgramCacheKey = () => 'grass-field-v5';
  return m;
}

// A height texture for the course: base grid heights, re-sampled through hAt where
// an HD patch replaces them (so blades stand on the ground the turf draws).
function heightTexture(elev, hAt, hdBounds) {
  const { nx, ny, cellM, minX, minY } = elev;
  const data = Float32Array.from(elev.heights);
  for (const b of hdBounds || []) {
    const i0 = Math.max(0, Math.floor((b.minX - minX) / cellM)), i1 = Math.min(nx - 1, Math.ceil((b.maxX - minX) / cellM));
    const j0 = Math.max(0, Math.floor((b.minY - minY) / cellM)), j1 = Math.min(ny - 1, Math.ceil((b.maxY - minY) / cellM));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) data[j * nx + i] = hAt(minX + i * cellM, minY + j * cellM);
  }
  const t = new THREE.DataTexture(data, nx, ny, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// Lowest and highest ground in each TILE x TILE block of height cells (a tile's last
// row and column overlap the next tile: the bilinear span between them is covered).
const TILE = 4;
export function heightRanges(heights, nx, ny) {
  const tx = Math.ceil(nx / TILE), ty = Math.ceil(ny / TILE);
  const lo = new Float32Array(tx * ty), hi = new Float32Array(tx * ty);
  for (let b = 0; b < ty; b++) {
    for (let a = 0; a < tx; a++) {
      let l = Infinity, h = -Infinity;
      for (let j = b * TILE; j <= Math.min(ny - 1, (b + 1) * TILE); j++) {
        for (let i = a * TILE; i <= Math.min(nx - 1, (a + 1) * TILE); i++) {
          const v = heights[j * nx + i];
          if (v < l) l = v;
          if (v > h) h = v;
        }
      }
      lo[b * tx + a] = l; hi[b * tx + a] = h;
    }
  }
  return { tx, ty, lo, hi };
}

// The rect of a ring's cells worth drawing for this camera: the square around the
// camera is cut into BLOCKS x BLOCKS blocks; a block counts when some of its ground
// is within the ring's reach (height included) and its box (ground range plus blade
// room) meets the view frustum. Returns { i0, j0, w, h } in world cells, or null.
const BLOCKS = 12;
const _box = new THREE.Box3();
export function visibleCells(frustum, cam, reach, spacing, rangeAt) {
  const cx = cam.x, cy = -cam.z, B = (2 * reach) / BLOCKS, pad = 0.25;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < BLOCKS; j++) {
    const by0 = cy - reach + j * B, by1 = by0 + B;
    const dy = Math.max(by0 - cy, 0, cy - by1);
    for (let i = 0; i < BLOCKS; i++) {
      const bx0 = cx - reach + i * B, bx1 = bx0 + B;
      const dx = Math.max(bx0 - cx, 0, cx - bx1);
      if (dx * dx + dy * dy > reach * reach) continue;
      const [lo, hi] = rangeAt(bx0, by0, bx1, by1);
      const dz = Math.max(0, cam.y - hi - 0.3, lo - cam.y);   // nearest the ground there gets, vertically
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      _box.min.set(bx0 - pad, lo - 0.1, -by1 - pad);
      _box.max.set(bx1 + pad, hi + 0.4, -by0 + pad);
      if (!frustum.intersectsBox(_box)) continue;
      if (bx0 < x0) x0 = bx0;
      if (bx1 > x1) x1 = bx1;
      if (by0 < y0) y0 = by0;
      if (by1 > y1) y1 = by1;
    }
  }
  if (x0 > x1) return null;
  const i0 = Math.floor(x0 / spacing), j0 = Math.floor(y0 / spacing);
  return { i0, j0, w: Math.ceil(x1 / spacing) - i0, h: Math.ceil(y1 / spacing) - j0 };
}

const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4();

// turf: scene._turfInputs ({ baseMap, mownMask, bunkerMask, bounds }); elev: the
// course elevation grid; hAt: scene.hAt; hdBounds: sim-metre rects of HD terrain.
export class GrassField {
  constructor({ turf, elev, hAt, hdBounds = [], scale = 1, sunDir = null }) {
    this.group = new THREE.Group();
    this.group.name = 'grassField';
    const b = turf.bounds;
    this.height = heightTexture(elev, hAt, hdBounds);
    this._ranges = heightRanges(this.height.image.data, elev.nx, elev.ny);
    this._elev = { minX: elev.minX, minY: elev.minY, cellM: elev.cellM };
    this._span = [0, 0];
    this._rangeAt = (x0, y0, x1, y1) => this._groundRange(x0, y0, x1, y1);
    const common = {
      uTime: { value: 0 },
      uBounds: { value: new THREE.Vector4(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY) },
      uMown: { value: turf.mownMask },
      uAux: { value: turf.bunkerMask },
      uBase: { value: turf.baseMap },
      uHeight: { value: this.height },
      uHInfo: { value: new THREE.Vector4(elev.minX, elev.minY, elev.cellM, 0) },
      uHSize: { value: new THREE.Vector2(elev.nx, elev.ny) },
      uSunDir: { value: sunDir || new THREE.Vector3(0.4, 0.8, -0.4) },   // live ref: follows the sky
    };
    this._time = common.uTime;
    const geom = clumpGeometry();
    // [spacing m, fade start, fade end (m from the camera), mown blade m, rough blade m]
    const k = 1 / Math.sqrt(scale);
    const rings = [
      // a dense ring at the camera (low cameras: launch, landing, free), the play
      // ring, and the rough out to ~30 m
      [0.03 * k, 3.1, 4.5, 0.03, 0.07],
      [0.07 * k, 6.2, 11.1, 0.035, 0.085],
      [0.18 * k, 18, 30, 0.0, 0.11],
    ];
    this.rings = rings.map(([spacing, f0, f1, hm, hr]) => {
      const u = {
        ...common,
        uSpacing: { value: spacing }, uGrid: { value: 1 },
        uOriginCell: { value: new THREE.Vector2() },
        uFade: { value: new THREE.Vector2(f0, f1) },
        uBladeH: { value: new THREE.Vector2(hm, hr) },
      };
      const g = geom.clone();
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, grassMaterial(u));
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
      return { spacing, reach: f1, u, mesh };
    });
    geom.dispose();
  }

  // ground height range under a sim-metre rect (from the tile ranges)
  _groundRange(x0, y0, x1, y1) {
    const { tx, ty, lo, hi } = this._ranges, e = this._elev, s = e.cellM * TILE;
    const a0 = Math.min(tx - 1, Math.max(0, Math.floor((x0 - e.minX) / s))), a1 = Math.min(tx - 1, Math.max(0, Math.floor((x1 - e.minX) / s)));
    const b0 = Math.min(ty - 1, Math.max(0, Math.floor((y0 - e.minY) / s))), b1 = Math.min(ty - 1, Math.max(0, Math.floor((y1 - e.minY) / s)));
    let l = Infinity, h = -Infinity;
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        if (lo[b * tx + a] < l) l = lo[b * tx + a];
        if (hi[b * tx + a] > h) h = hi[b * tx + a];
      }
    }
    this._span[0] = l; this._span[1] = h;
    return this._span;
  }

  // Fit each ring's rect to what this camera sees (none at all from high up).
  update(camera, timeSec) {
    this._time.value = timeSec;
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (const r of this.rings) {
      const c = visibleCells(_frustum, camera.position, r.reach, r.spacing, this._rangeAt);
      if (c) {
        r.u.uOriginCell.value.set(c.i0, c.j0);
        r.u.uGrid.value = c.w;
      }
      r.mesh.geometry.instanceCount = c ? c.w * c.h : 0;
    }
  }

  dispose() {
    for (const r of this.rings) { r.mesh.geometry.dispose(); r.mesh.material.dispose(); }
    this.height.dispose();
  }
}
