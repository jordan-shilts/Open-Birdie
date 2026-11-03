// Near-camera grass: real blades on every mown and rough surface around the camera,
// so the ground at the ball, on a tee box or along a fairway edge reads as grass,
// not a texture — wherever the camera is (address, ball flight, free camera).
//
// GPU-placed: a fixed grid of blade clumps follows the camera in world-snapped
// steps (a clump's spot and look come from a hash of its world cell, so blades never
// swim as the grid moves). Each clump reads the same surface masks the turf shader
// uses — greens, sand and water get none; fairway and tees a short cut; rough a
// longer one — takes the turf's own base colour under it, and stands on the ground
// from a height texture sampled from scene.hAt (so lidar and HD terrain both match
// what the turf draws). Blades shrink to nothing toward the ring's edge, so the field
// ends without a line. Two rings: a fine one for the few metres around the camera
// and a coarse one out to ~35 m (rough only: a mown cut is sub-pixel by then).
import * as THREE from 'three';

// One clump: three tapered, slightly curved blades fanned around a point.
// position.y runs 0 (base) -> 1 (tip); x/z are metres at unit width.
function clumpGeometry() {
  const pos = [], idx = [];
  const blades = [[0, 0.012, 0.0], [2.1, 0.016, 0.35], [4.2, 0.01, -0.3]];
  let v = 0;
  for (const [ang, off, lean] of blades) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const ox = Math.cos(ang + 1.3) * off, oz = Math.sin(ang + 1.3) * off;
    const segs = 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, w = 0.0068 * (1 - 0.88 * t);
      const bend = lean * t * t * 0.4;   // curls over toward the tip
      for (const side of [-1, 1]) {
        pos.push(ox + c * w * side + s * bend, t, oz + s * w * side - c * bend);
      }
    }
    for (let i = 0; i < segs; i++) { const a = v + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    v += (segs + 1) * 2;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

const GRASS_VERT = /* glsl */`
  uniform float uTime, uSpacing, uGrid;
  uniform vec2 uOriginCell;              // world cell of grid (0, 0)
  uniform vec4 uBounds;                  // sim minX, minY, extX, extY of the masks
  uniform sampler2D uMown, uAux, uBase;  // turf masks + base colour (scene.js)
  uniform sampler2D uHeight;             // ground heights (R32F, nearest)
  uniform vec4 uHInfo;                   // sim minX, minY, cellM, (unused)
  uniform vec2 uHSize;                   // height texture size
  uniform vec2 uFade;                    // full size inside .x, gone by .y (m from camera)
  uniform vec2 uBladeH;                  // blade height (m): mown cut, rough
  varying vec3 vGrassCol;
  varying float vTip;
  vec2 gHash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  float gGround(vec2 sim) {
    vec2 g = clamp((sim - uHInfo.xy) / uHInfo.z, vec2(0.0), uHSize - 1.001);
    ivec2 i = ivec2(floor(g));
    vec2 f = fract(g);
    float a = texelFetch(uHeight, i, 0).r, b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
    float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r, d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }`;

const GRASS_BEGIN = /* glsl */`
  vec3 transformed;
  {
    float id = float(gl_InstanceID);
    vec2 wc = uOriginCell + vec2(mod(id, uGrid), floor(id / uGrid));
    vec2 hh = gHash(wc);
    vec2 sim = (wc + hh) * uSpacing;                       // jittered inside its cell
    vec2 suv = (sim - uBounds.xy) / uBounds.zw;
    float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    vec4 mown = texture2D(uMown, suv);                     // r: fairway/tee/green, g: green
    vec4 aux = texture2D(uAux, suv);                       // r: tee, g: water, b: bunker
    float bare = max(smoothstep(0.25, 0.6, mown.g), smoothstep(0.15, 0.45, max(aux.g, aux.b)));
    float cut = smoothstep(0.35, 0.75, mown.r);
    float h = mix(uBladeH.y, uBladeH.x, cut) * (0.65 + 0.7 * hh.x) * (1.0 - bare) * inside;
    float dcam = length(vec2(sim.x - cameraPosition.x, -sim.y - cameraPosition.z));
    float fk = 1.0 - smoothstep(uFade.x, uFade.y, dcam);
    h *= fk;
    float a = hh.y * 6.2831853;
    vec2 r = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xz * mix(1.4, 1.0, cut) * (0.55 + 0.45 * fk);
    float t = position.y;
    // wind: a slow gusting lean plus a little per-clump flutter, more on long blades
    float sway = (sin(uTime * 1.3 + sim.x * 0.21 + sim.y * 0.17) * 0.6 + sin(uTime * 2.9 + hh.x * 30.0) * 0.4) * (0.08 + 0.25 * (1.0 - cut));
    vec3 wp = vec3(sim.x + r.x, gGround(sim) - 0.02 + t * h, -sim.y + r.y);
    wp.x += sway * t * t * h;
    wp.z += sway * 0.5 * t * t * h;
    transformed = wp;
    // the turf's own base colour: dark deep in the clump (the blades shade each other),
    // bright toward the lit tips, so a blade reads against the ground it grows from
    // instead of melting into it; one clump in seven a shade yellower (older blades)
    vec3 base = texture2D(uBase, suv).rgb;
    float older = step(0.86, fract(hh.x * 7.31 + hh.y * 3.17));
    vGrassCol = base * mix(vec3(1.0), vec3(1.25, 1.1, 0.62), older * 0.55) * mix(0.38, 1.28, t) * (0.78 + 0.44 * hh.x);
    vTip = t;
  }`;

function grassMaterial(u) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GRASS_VERT}`)
      // lit like the ground it grows from (normal up), so the field matches the turf
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', GRASS_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;\nvarying float vTip;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb *= vGrassCol;')
      // a blade's back face must keep the up normal (DoubleSide flips it: black blades)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal); nonPerturbedNormal = normal;');
  };
  m.customProgramCacheKey = () => 'grass-field-v2';
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

// turf: scene._turfInputs ({ baseMap, mownMask, bunkerMask, bounds }); elev: the
// course elevation grid; hAt: scene.hAt; hdBounds: sim-metre rects of HD terrain.
export class GrassField {
  constructor({ turf, elev, hAt, hdBounds = [], scale = 1 }) {
    this.group = new THREE.Group();
    this.group.name = 'grassField';
    const b = turf.bounds;
    this.height = heightTexture(elev, hAt, hdBounds);
    const common = {
      uTime: { value: 0 },
      uBounds: { value: new THREE.Vector4(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY) },
      uMown: { value: turf.mownMask },
      uAux: { value: turf.bunkerMask },
      uBase: { value: turf.baseMap },
      uHeight: { value: this.height },
      uHInfo: { value: new THREE.Vector4(elev.minX, elev.minY, elev.cellM, 0) },
      uHSize: { value: new THREE.Vector2(elev.nx, elev.ny) },
    };
    this._time = common.uTime;
    const geom = clumpGeometry();
    // [spacing m, grid N, fade start, fade end, mown blade m, rough blade m]
    const rings = [
      [0.085 / Math.sqrt(scale), Math.round(290 * Math.sqrt(scale)), 7, 12, 0.04, 0.08],
      [0.24 / Math.sqrt(scale), Math.round(270 * Math.sqrt(scale)), 20, 34, 0.0, 0.1],
    ];
    this.rings = rings.map(([spacing, N, f0, f1, hm, hr]) => {
      const u = {
        ...common,
        uSpacing: { value: spacing }, uGrid: { value: N },
        uOriginCell: { value: new THREE.Vector2() },
        uFade: { value: new THREE.Vector2(f0, f1) },
        uBladeH: { value: new THREE.Vector2(hm, hr) },
      };
      const g = geom.clone();
      g.instanceCount = N * N;
      const mesh = new THREE.Mesh(g, grassMaterial(u));
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
      return { spacing, N, reach: f1, u, mesh };
    });
    geom.dispose();
  }

  // Centre each ring on the camera (pushed ahead along the view so most clumps are
  // on screen), snapped to whole cells.
  update(camera, timeSec) {
    this._time.value = timeSec;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const fx = dir.x, fz = dir.z, fl = Math.hypot(fx, fz) || 1;
    for (const r of this.rings) {
      const ahead = r.reach * 0.45;
      const sx = camera.position.x + (fx / fl) * ahead, sy = -(camera.position.z + (fz / fl) * ahead);
      r.u.uOriginCell.value.set(Math.floor(sx / r.spacing) - r.N / 2, Math.floor(sy / r.spacing) - r.N / 2);
    }
  }

  dispose() {
    for (const r of this.rings) { r.mesh.geometry.dispose(); r.mesh.material.dispose(); }
    this.height.dispose();
  }
}
