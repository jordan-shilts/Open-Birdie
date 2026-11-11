// Shot presentation in 3D: a broadcast-style tracer that grows with the ball and lingers
// a few seconds after the shot, apex + landing markers, and a soft contact shadow under
// the ball. All unlit/additive, no textures, no shadows — a handful of draw calls on top
// of the scene.
//
// The tracer is there to show the shot's shape, never to cover the shot: it is bright
// and full width only just behind the ball (a comet), thins to a faint line further
// back, and fades out toward the camera, so a camera riding behind the ball looks past
// it at the ball and the ground it is coming down on.
import * as THREE from 'three';

export const TRACER_WIDTH_PX = 6;      // the ribbon's width just behind the ball
export const TRACER_THIN = 0.5;        // ...and the share of it the older trail keeps
export const TRACER_FRESH_S = 0.8;     // the comet: this much flight behind the ball is at full strength
export const TRACER_TAIL = 0.3;        // how much of the older trail's strength is left
export const TRACER_NEAR_M = Object.freeze([3, 9]);   // gone at the first distance from the camera, whole from the second

const smooth01 = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// How strongly the trail is drawn (0..1) and how wide (share of TRACER_WIDTH_PX) at a
// point the ball passed ageS ago, distM from the camera. The shader below does the same
// sums; this is the copy the tests check (test/shot-fx.test.mjs).
export function tracerVisibility(ageS, distM) {
  const fresh = 1 - smooth01(0, TRACER_FRESH_S, Math.max(0, ageS));
  const near = smooth01(TRACER_NEAR_M[0], TRACER_NEAR_M[1], distM);
  return { strength: (TRACER_TAIL + (1 - TRACER_TAIL) * fresh) * near, width: TRACER_THIN + (1 - TRACER_THIN) * fresh };
}

const TRACER_VERT = /* glsl */`
  uniform float uPxWorld;   // world metres per pixel at 1 m depth (2 tan(fov/2) / viewport h)
  uniform float uPx;        // ribbon width in pixels
  uniform float uMinW;      // minimum world width (m)
  uniform float uHead;      // sim time of the ball
  uniform float uFreshS;    // the comet's length (s of flight)
  uniform float uThin;      // the older trail's share of the width
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aT;
  varying float vSide;
  varying float vT;
  varying float vDist;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 toCam = cameraPosition - wp.xyz;
    float dist = length(toCam);
    vec3 side = cross(aDir, toCam / max(dist, 1e-4));
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    float fresh = 1.0 - smoothstep(0.0, uFreshS, max(0.0, uHead - aT));
    float w = max(uMinW, dist * uPxWorld * uPx) * mix(uThin, 1.0, fresh);
    wp.xyz += side * aSide * w * 0.5;
    vSide = aSide;
    vT = aT;
    vDist = dist;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const TRACER_FRAG = /* glsl */`
  uniform float uHead;      // sim time of the ball: samples later than this aren't drawn yet
  uniform float uAlpha;     // overall fade (linger -> gone)
  uniform vec3 uColor;      // glow colour
  uniform vec3 uCore;       // hot core colour
  uniform float uFreshS;    // the comet's length (s of flight)
  uniform float uTail;      // what is left of the older trail's strength
  uniform vec2 uNear;       // fades out toward the camera between these distances (m)
  varying float vSide;
  varying float vT;
  varying float vDist;
  void main() {
    if (vT > uHead) discard;
    float e = 1.0 - abs(vSide);               // 0 at the ribbon edge, 1 on its spine
    float core = smoothstep(0.62, 1.0, e);
    float glow = e * e * e;
    float fresh = 1.0 - smoothstep(0.0, uFreshS, uHead - vT);   // the comet just behind the ball
    // only the comet is bright enough to bloom; the older trail is a plain thin line
    vec3 col = mix(uColor, uCore, core) * (1.0 + 1.2 * core + (0.8 + 1.6 * core) * fresh);
    float a = clamp(glow * 0.75 + core * 0.9, 0.0, 1.0) * uAlpha
      * mix(uTail, 1.0, fresh) * smoothstep(uNear.x, uNear.y, vDist);
    if (a < 0.003) discard;
    gl_FragColor = vec4(col * a, a);
  }`;

// One trajectory -> a camera-facing ribbon (two verts per sample, expanded in the
// vertex shader so it stays ~uPx pixels wide at any distance). Air phase only.
export class ShotTracer {
  constructor(points3, times, { color = 0xffb21e, core = 0xfff3c4, widthPx = TRACER_WIDTH_PX } = {}) {
    const n = points3.length;
    const pos = new Float32Array(n * 2 * 3);
    const dir = new Float32Array(n * 2 * 3);
    const side = new Float32Array(n * 2);
    const tt = new Float32Array(n * 2);
    const d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = points3[Math.max(0, i - 1)], b = points3[Math.min(n - 1, i + 1)];
      d.subVectors(b, a);
      if (d.lengthSq() < 1e-10) d.set(0, 0, -1);
      d.normalize();
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        pos[j * 3] = points3[i].x; pos[j * 3 + 1] = points3[i].y; pos[j * 3 + 2] = points3[i].z;
        dir[j * 3] = d.x; dir[j * 3 + 1] = d.y; dir[j * 3 + 2] = d.z;
        side[j] = k ? 1 : -1;
        tt[j] = times[i];
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.uniforms = {
      uPxWorld: { value: 0.0015 },
      uPx: { value: widthPx },
      uMinW: { value: 0.05 },
      uHead: { value: -1 },
      uAlpha: { value: 1 },
      uFreshS: { value: TRACER_FRESH_S },
      uThin: { value: TRACER_THIN },
      uTail: { value: TRACER_TAIL },
      uNear: { value: new THREE.Vector2(TRACER_NEAR_M[0], TRACER_NEAR_M[1]) },
      uColor: { value: new THREE.Color(color) },
      uCore: { value: new THREE.Color(core) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: TRACER_VERT, fragmentShader: TRACER_FRAG,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide, fog: false,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.endT = times[n - 1];
  }

  update(camera, viewportH, head, alpha) {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    this.uniforms.uPxWorld.value = (2 * Math.tan(fov / 2)) / Math.max(1, viewportH);
    this.uniforms.uHead.value = head;
    this.uniforms.uAlpha.value = alpha;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// Soft round glow billboard (ball head while in flight, apex dot).
const GLOW_VERT = /* glsl */`
  uniform float uPxWorld; uniform float uPx; uniform float uMinW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float w = max(uMinW, -mv.z * uPxWorld * uPx);
    mv.xy += position.xy * w;
    gl_Position = projectionMatrix * mv;
  }`;
const GLOW_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float a = (smoothstep(1.0, 0.0, r) * 0.55 + smoothstep(0.38, 0.0, r)) * uAlpha;
    gl_FragColor = vec4(uColor * a * 2.4, a);
  }`;

export function makeGlow({ color = 0xffe08a, px = 22 } = {}) {
  const uniforms = {
    uPxWorld: { value: 0.0015 }, uPx: { value: px }, uMinW: { value: 0.12 },
    uColor: { value: new THREE.Color(color) }, uAlpha: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 11;
  m.userData.uniforms = uniforms;
  return m;
}

// Target ring on the ground at the landing spot (constant-ish screen size), with an
// expanding pulse. The scene dims it once the ball is down (landingRingAlpha).
export const LAND_RING_SETTLE_S = Object.freeze([0.8, 2.4]);   // full until the first, dimmed by the second (s after touchdown)
export const LAND_RING_REST = 0.35;                            // what is left of it then
export function landingRingAlpha(sinceLandingS) {
  return 1 - (1 - LAND_RING_REST) * smooth01(LAND_RING_SETTLE_S[0], LAND_RING_SETTLE_S[1], sinceLandingS);
}

const RING_FRAG = /* glsl */`
  uniform float uTime; uniform float uAlpha; uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    // a thin ring and its pulse: nothing drawn over the middle, where the ball is
    float ring = smoothstep(0.86, 0.90, r) * (1.0 - smoothstep(0.95, 1.0, r));
    float pulseR = fract(uTime * 0.7);
    float pulse = (1.0 - smoothstep(0.0, 0.05, abs(r - pulseR))) * (1.0 - pulseR) * 0.5 * smoothstep(0.2, 0.4, r);
    float a = clamp(ring + pulse, 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(uColor * a * 1.8, a);
  }`;

export function makeLandingRing({ color = 0xffffff } = {}) {
  const uniforms = { uTime: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(color) } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: RING_FRAG,
    transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 9;
  m.frustumCulled = false;
  m.userData.uniforms = uniforms;
  return m;
}

// Soft dark contact blob under the ball; size/opacity follow the ball's height.
export function makeBallShadow() {
  const s = 64, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const gr = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)');
  gr.addColorStop(0.5, 'rgba(0,0,0,0.35)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 2;
  m.userData.disposeTextures = [tex];
  return m;
}

// Thin dashed drop line from the apex to the ground.
export function makeDropLine() {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]);
  const mat = new THREE.LineDashedMaterial({
    color: 0xffd36a, transparent: true, opacity: 0.0, dashSize: 1.2, gapSize: 1.0, depthWrite: false, fog: false,
  });
  const line = new THREE.Line(g, mat);
  line.frustumCulled = false;
  line.renderOrder = 9;
  return line;
}
