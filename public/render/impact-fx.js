// What the ball throws up where it lands: a splash and spreading rings on water, a
// burst of sand from a bunker, a few bits of turf and a puff of dust off the fairway or
// the rough, leaves from a tree crown. Nothing on a green (a ball leaves a pitch mark
// there, not debris) and nothing for a putt.
//
// One pool of point sprites flown on the GPU (start, velocity, birth: no per-frame
// JavaScript per particle) plus a few flat ring quads for the water. Nothing is drawn
// while nothing is alive, so the cost between shots is zero.
import * as THREE from 'three';

// ---------------------------------------------------------------- when and how hard
// The server's shot carries its events (lib/physics.js): { type: 'bounce', x, y, surface },
// { type: 'water', x, y } and { type: 'tree', t, x, y, z, part }. Bounces and water carry
// no time, so each is matched to the trajectory sample nearest it, searching forward from
// the last one (a ball that spins back over its own pitch mark matches the first pass).
// Pure: no three, no DOM (test/impact-fx.test.mjs).

const GROUND_KINDS = Object.freeze({ bunker: 'sand', green: null });   // every other surface: turf
export const IMPACT_MIN_TURF_MPS = 6;   // slower than this down into grass throws nothing up
export const IMPACT_MIN_SAND_MPS = 1;

function nearestSampleFrom(points, i0, x, y) {
  let best = -1, bestD = Infinity;
  for (let i = i0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - x, points[i].y - y);
    if (d < bestD) { bestD = d; best = i; }
    // it came by and is moving away again: this pass is the one, whatever comes back later
    else if (bestD < 2.5 && d > bestD + 0.75) break;
  }
  return best;
}

// The ball's velocity coming into sample i, over the ~60 ms before it.
function arrivalVelocity(points, i) {
  const b = points[i];
  let j = i - 1;
  while (j > 0 && b.t - points[j].t < 0.06) j--;
  if (j < 0) return { vx: 0, vy: 0, vz: 0 };
  const a = points[j], dt = b.t - a.t;
  if (!(dt > 0)) return { vx: 0, vy: 0, vz: 0 };
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt, vz: (b.z - a.z) / dt };
}

// -> [{ t, x, y, z, kind: 'water' | 'sand' | 'turf' | 'leaves', power: 0..1, dirX, dirY }]
// in time order. z is set for leaves (the height of the hit); ground impacts take the
// ground's height where they are drawn.
export function impactSchedule(points, events, flightTime, { isPutt = false } = {}) {
  if (isPutt || !Array.isArray(points) || points.length < 2 || !Array.isArray(events)) return [];
  const out = [];
  let from = 0, grounded = false;
  for (const ev of events) {
    if (!ev || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) continue;
    if (ev.type === 'tree') {
      if (ev.part !== 'crown' || !Number.isFinite(ev.t)) continue;
      let i = from;
      while (i < points.length - 1 && points[i].t < ev.t) i++;
      const v = arrivalVelocity(points, i);
      const speed = Math.hypot(v.vx, v.vy, v.vz);
      const h = Math.hypot(v.vx, v.vy) || 1;
      out.push({
        t: ev.t, x: ev.x, y: ev.y, z: Number.isFinite(ev.z) ? ev.z : points[i].z, kind: 'leaves',
        power: Math.min(1, Math.max(0.3, speed / 40)), dirX: v.vx / h, dirY: v.vy / h,
      });
      continue;
    }
    if (ev.type !== 'bounce' && ev.type !== 'water') continue;
    const i = nearestSampleFrom(points, from, ev.x, ev.y);
    if (i < 0) continue;
    from = i + 1;
    // the first touch of the ground is the end of the carry, which the server times exactly
    let t = points[i].t;
    if (!grounded && Number.isFinite(flightTime) && Math.abs(t - flightTime) < 0.3) t = flightTime;
    grounded = true;
    const v = arrivalVelocity(points, i);
    const down = Math.max(0, -v.vz), speed = Math.hypot(v.vx, v.vy, v.vz);
    const h = Math.hypot(v.vx, v.vy);
    const dirX = h > 1e-6 ? v.vx / h : 0, dirY = h > 1e-6 ? v.vy / h : 0;
    if (ev.type === 'water') {
      // a ball that only rolls in still goes under with a plop
      out.push({ t, x: ev.x, y: ev.y, kind: 'water', power: Math.min(1, Math.max(0.3, 0.25 + speed / 32)), dirX, dirY });
      continue;
    }
    const kind = Object.prototype.hasOwnProperty.call(GROUND_KINDS, ev.surface) ? GROUND_KINDS[ev.surface] : 'turf';
    if (!kind) continue;
    if (down < (kind === 'sand' ? IMPACT_MIN_SAND_MPS : IMPACT_MIN_TURF_MPS)) continue;
    out.push({ t, x: ev.x, y: ev.y, kind, power: Math.min(1, Math.max(0.2, down / 16)), dirX, dirY });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- the particles
// What each kind throws: [count at full power, ...]. Colours are albedo-like (linear);
// the shader multiplies by the scene's light level so a splash at golden hour is not lit
// like one at midday.
const RECIPES = Object.freeze({
  water: [
    // the column: fast, narrow, straight up
    { n: 70, up: [3.0, 6.6], out: [0.1, 1.0], size: [0.03, 0.09], life: [0.7, 1.3], grav: 1, drag: 0.5, grow: 0.2, alpha: 0.9, col: [[0.80, 0.87, 0.93], [0.96, 0.98, 1.0]] },
    // the crown: a ring thrown outward and up
    { n: 80, up: [1.5, 3.6], out: [1.4, 3.8], size: [0.025, 0.075], life: [0.55, 1.05], grav: 1, drag: 0.6, grow: 0.2, alpha: 0.85, col: [[0.74, 0.83, 0.9], [0.93, 0.96, 1.0]] },
    // the white of it: broken water at the foot of the column, gone in a moment
    { n: 8, up: [0.8, 3.2], out: [0.1, 0.9], size: [0.22, 0.45], life: [0.28, 0.5], grav: 0.5, drag: 1.8, grow: 1.3, alpha: 0.2, col: [[0.86, 0.91, 0.95], [0.97, 0.98, 1.0]] },
    // spray: fine mist that hangs
    { n: 9, up: [1.0, 3.0], out: [0.3, 1.6], size: [0.35, 0.75], life: [0.6, 1.1], grav: 0.2, drag: 2.0, grow: 1.6, alpha: 0.09, col: [[0.85, 0.9, 0.95], [0.95, 0.97, 1.0]] },
  ],
  sand: [
    // grains: a fan thrown forward and up
    { n: 70, up: [2.2, 6.2], out: [1.0, 4.6], fwd: 0.75, size: [0.035, 0.085], life: [0.5, 0.95], grav: 1, drag: 0.9, grow: 0.1, alpha: 0.9, col: [[0.62, 0.56, 0.44], [0.80, 0.75, 0.62]] },
    // the cloud of fines that hangs and drifts
    { n: 10, up: [0.6, 2.0], out: [0.4, 2.0], fwd: 0.6, size: [0.35, 0.8], life: [0.8, 1.5], grav: 0.12, drag: 2.4, grow: 1.8, alpha: 0.12, col: [[0.66, 0.61, 0.50], [0.78, 0.74, 0.63]] },
  ],
  turf: [
    // bits of grass and soil
    { n: 14, up: [1.4, 3.6], out: [0.5, 2.4], fwd: 0.8, size: [0.03, 0.07], life: [0.4, 0.75], grav: 1, drag: 0.8, grow: 0, alpha: 0.9, col: [[0.10, 0.16, 0.05], [0.22, 0.17, 0.09]] },
    // a breath of dust
    { n: 5, up: [0.3, 0.9], out: [0.2, 0.9], fwd: 0.5, size: [0.35, 0.7], life: [0.5, 0.9], grav: 0.05, drag: 2.6, grow: 1.5, alpha: 0.1, col: [[0.5, 0.48, 0.38], [0.62, 0.6, 0.48]] },
  ],
  leaves: [
    // leaves knocked loose: they scatter, then flutter down
    { n: 16, up: [-0.5, 1.6], out: [0.5, 3.2], fwd: 0.55, size: [0.07, 0.13], life: [1.3, 2.4], grav: 0.22, drag: 1.6, grow: 0, alpha: 0.95, col: [[0.10, 0.20, 0.05], [0.24, 0.30, 0.08]] },
  ],
});

const VERT = /* glsl */`
  uniform float uTime;      // seconds, the scene's frame time
  uniform float uPxPerM;    // drawing-buffer pixels a metre covers at 1 m
  attribute vec3 aVel;
  attribute vec3 aLife;     // x birth time, y lifetime, z growth over the lifetime (x of size)
  attribute vec4 aLook;     // x size (m), y gravity scale, z drag (1/s), w opacity
  attribute vec3 aColor;
  varying vec4 vCol;
  #include <fog_pars_vertex>
  void main() {
    float age = uTime - aLife.x;
    float k = age / max(aLife.y, 1e-3);
    if (age < 0.0 || k >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vCol = vec4(0.0);
      return;
    }
    // drag slows it as it goes: distance = v (1 - e^(-d t)) / d
    float d = aLook.z;
    float reach = d > 1e-4 ? (1.0 - exp(-d * age)) / d : age;
    vec3 p = position + aVel * reach;
    p.y -= 4.9 * aLook.y * age * age;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float size = aLook.x * (1.0 + aLife.z * k);
    gl_PointSize = clamp(size * uPxPerM / max(-mvPosition.z, 0.1), 1.5, 128.0);
    float fade = smoothstep(0.0, 0.06, k) * (1.0 - smoothstep(0.5, 1.0, k));
    vCol = vec4(aColor, aLook.w * fade);
    #include <fog_vertex>
  }`;

const FRAG = /* glsl */`
  uniform vec3 uLight;      // the scene's light on a lit, upward-facing surface (linear)
  varying vec4 vCol;
  #include <fog_pars_fragment>
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = vCol.a * (1.0 - smoothstep(0.55, 1.0, r));
    if (a < 0.004) discard;
    gl_FragColor = vec4(vCol.rgb * uLight, a);
    #include <fog_fragment>
  }`;

const RING_VERT = /* glsl */`
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

// Rings spreading from where the ball went in: three wave crests leaving one after
// another, each thinning and fading as it widens.
const RING_FRAG = /* glsl */`
  uniform float uAge;       // seconds since the ball went in
  uniform float uLife;
  uniform float uPower;
  uniform vec3 uLight;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    float r = length(vUv - 0.5) * 2.0;       // 0 centre .. 1 the quad's edge
    float a = 0.0;
    for (int i = 0; i < 3; i++) {
      float age = uAge - float(i) * 0.32;
      if (age <= 0.0) continue;
      float k = age / uLife;
      float radius = 0.06 + 0.94 * (1.0 - exp(-2.4 * k));   // fast out, then slowing
      float w = mix(0.02, 0.008, k);
      float crest = 1.0 - smoothstep(0.0, w, abs(r - radius));
      a += crest * (1.0 - smoothstep(0.15, 1.0, k)) * (1.0 - 0.3 * float(i));
    }
    a *= (1.0 - smoothstep(0.9, 1.0, r)) * (0.09 + 0.1 * uPower);   // a glint on a ripple, not a painted hoop
    if (a < 0.004) discard;
    gl_FragColor = vec4(vec3(0.82, 0.88, 0.93) * uLight, a);
    #include <fog_fragment>
  }`;

const RING_COUNT = 3;
const RING_LIFE_S = 3.2;

// A small repeatable random stream, so a capture at a fixed time draws the same splash.
function seeded(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class ImpactFx {
  constructor({ capacity = 768 } = {}) {
    this.capacity = capacity;
    this._next = 0;
    this._aliveUntil = -Infinity;
    this._spawned = 0;
    const g = new THREE.BufferGeometry();
    this._pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this._vel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this._life = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this._look = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4);
    this._col = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    // every slot starts dead (born long ago with no lifetime)
    for (let i = 0; i < capacity; i++) { this._life.array[i * 3] = -1e6; this._life.array[i * 3 + 1] = 1e-3; }
    for (const a of [this._pos, this._vel, this._life, this._look, this._col]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this._pos);
    g.setAttribute('aVel', this._vel);
    g.setAttribute('aLife', this._life);
    g.setAttribute('aLook', this._look);
    g.setAttribute('aColor', this._col);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uPxPerM: { value: 800 }, uLight: { value: new THREE.Color(1, 1, 1) },
    }]);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, fog: true,
    });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'impactFx';
    this.points.frustumCulled = false;   // the particles fly from wherever the ball lands
    this.points.renderOrder = 12;        // over the water and the ground decals
    this.points.visible = false;

    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < RING_COUNT; i++) {
      const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uAge: { value: 0 }, uLife: { value: RING_LIFE_S }, uPower: { value: 1 }, uLight: { value: new THREE.Color(1, 1, 1) },
      }]);
      const m = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
        uniforms, vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        transparent: true, depthWrite: false, fog: true,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      m.name = 'impactRing';
      m.renderOrder = 11;
      m.visible = false;
      m.userData.uniforms = uniforms;
      m.userData.born = -Infinity;
      this.rings.push(m);
    }
    this._ringNext = 0;
    this.group = new THREE.Group();
    this.group.name = 'impactFx';
    this.group.add(this.points, ...this.rings);
  }

  // impact: an impactSchedule() entry. now: the scene's frame time (s). groundZ: the
  // ground's (or the water's) height at (x, y), sim metres.
  spawn(impact, now, groundZ = 0) {
    const recipe = RECIPES[impact.kind];
    if (!recipe) return 0;
    const power = Math.min(1, Math.max(0, impact.power ?? 1));
    const rnd = seeded(0x9e3779b9 ^ Math.round(impact.x * 131) ^ Math.round(impact.y * 977) ^ (this._spawned++ * 2654435761));
    const z0 = Number.isFinite(impact.z) ? impact.z : groundZ + 0.03;
    const dirX = impact.dirX || 0, dirY = impact.dirY || 0;
    let made = 0, lastDeath = now;
    for (const r of recipe) {
      const n = Math.max(1, Math.round(r.n * (0.35 + 0.65 * power)));
      for (let k = 0; k < n; k++) {
        const i = this._next;
        this._next = (this._next + 1) % this.capacity;
        const ang = rnd() * Math.PI * 2;
        // thrown outward all round, leaning the way the ball was travelling
        const outV = (r.out[0] + (r.out[1] - r.out[0]) * rnd()) * (0.55 + 0.45 * power);
        const upV = (r.up[0] + (r.up[1] - r.up[0]) * rnd()) * (0.5 + 0.5 * power);
        const lean = (r.fwd || 0) * outV;
        const vx = Math.cos(ang) * outV * (1 - 0.5 * (r.fwd || 0)) + dirX * lean;
        const vy = Math.sin(ang) * outV * (1 - 0.5 * (r.fwd || 0)) + dirY * lean;
        const j = rnd() * 0.12;
        // sim (x east, y north, z up) -> three (x, z, -y)
        this._pos.setXYZ(i, impact.x + Math.cos(ang) * j, z0, -(impact.y + Math.sin(ang) * j));
        this._vel.setXYZ(i, vx, upV, -vy);
        const life = r.life[0] + (r.life[1] - r.life[0]) * rnd();
        const birth = now + rnd() * 0.04;
        this._life.setXYZ(i, birth, life, r.grow);
        this._look.setXYZW(i, (r.size[0] + (r.size[1] - r.size[0]) * rnd()) * (0.8 + 0.4 * power), r.grav, r.drag, r.alpha);
        const c = rnd();
        this._col.setXYZ(i,
          r.col[0][0] + (r.col[1][0] - r.col[0][0]) * c,
          r.col[0][1] + (r.col[1][1] - r.col[0][1]) * c,
          r.col[0][2] + (r.col[1][2] - r.col[0][2]) * c);
        lastDeath = Math.max(lastDeath, birth + life);
        made++;
      }
    }
    for (const a of [this._pos, this._vel, this._life, this._look, this._col]) a.needsUpdate = true;
    this._aliveUntil = Math.max(this._aliveUntil, lastDeath);
    this.points.visible = true;
    if (impact.kind === 'water') {
      const ring = this.rings[this._ringNext];
      this._ringNext = (this._ringNext + 1) % RING_COUNT;
      const reach = 5 + 7 * power;               // metres the rings spread to
      ring.position.set(impact.x, groundZ + 0.04, -impact.y);
      ring.scale.set(reach * 2, 1, reach * 2);
      ring.userData.born = now;
      ring.userData.uniforms.uPower.value = power;
      ring.visible = true;
    }
    return made;
  }

  // Once a frame. light: THREE.Color, the light on a lit upward surface (linear).
  // viewportHpx: the drawing buffer's height in pixels. (The renderer feeds the scene's
  // fog to these materials itself: they are fog-aware ShaderMaterials.)
  update(now, camera, viewportHpx, light = null) {
    // time running backwards (a capture at an earlier fixed time, a clock reset): clear
    if (now < this._lastNow - 0.5) this.clear();
    this._lastNow = now;
    const alive = now <= this._aliveUntil;
    this.points.visible = alive;
    if (alive) {
      const u = this.uniforms;
      u.uTime.value = now;
      const fov = THREE.MathUtils.degToRad(camera.fov);
      u.uPxPerM.value = Math.max(1, viewportHpx) / (2 * Math.tan(fov / 2));
      if (light) u.uLight.value.copy(light);
    }
    for (const ring of this.rings) {
      if (!ring.visible) continue;
      const age = now - ring.userData.born;
      if (age < 0 || age > RING_LIFE_S + 0.7) { ring.visible = false; continue; }
      const u = ring.userData.uniforms;
      u.uAge.value = age;
      if (light) u.uLight.value.copy(light);
    }
  }

  get active() {
    return this.points.visible || this.rings.some((r) => r.visible);
  }

  clear() {
    this._aliveUntil = -Infinity;
    this.points.visible = false;
    for (let i = 0; i < this.capacity; i++) this._life.array[i * 3] = -1e6;
    this._life.needsUpdate = true;
    for (const r of this.rings) { r.visible = false; r.userData.born = -Infinity; }
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.rings[0]?.geometry.dispose();
    for (const r of this.rings) r.material.dispose();
  }
}
