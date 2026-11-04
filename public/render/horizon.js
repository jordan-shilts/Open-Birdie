// The world past the course edge. Without this the course was a floating slab in a
// sky sphere: its terrain edge read as a green wall on the horizon and the HDRI's
// lower hemisphere showed through underneath. Two pieces:
//
//  1. Ground apron — a ring mesh from the terrain bounds out to ~7 km. Its inner
//     ring samples the real terrain edge heights (no step), then eases to a gentle,
//     slightly lower countryside with low rolling hills that grow with distance so
//     the far field has a silhouette instead of a ruler-straight edge. Procedural
//     turf colour (macro patches) in the vertex/fragment shader; fog does the rest.
//  2. Horizon haze band — a camera-centred open cylinder far out, fog-coloured at
//     the horizon fading to clear by ~7 degrees up, so ground and sky meet in haze.
import * as THREE from 'three';

const NOISE_GLSL = /* glsl */`
  float hHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hNoise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hHash(i), hHash(i + vec2(1.0, 0.0)), f.x), mix(hHash(i + vec2(0.0, 1.0)), hHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float hFbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ s += a * hNoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

// deterministic value noise (JS twin of the GLSL above) for the apron heights
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function fbm(x, y) {
  let s = 0, a = 0.5;
  for (let k = 0; k < 4; k++) { s += a * vnoise(x, y); x *= 2.03; y *= 2.03; a *= 0.5; }
  return s;
}

// Rings, in metres beyond the course edge. Dense near the edge (where the terrain's
// last row meets the apron and the camera may be close), sparse far out.
const RINGS = [0, 25, 60, 120, 220, 380, 650, 1100, 1800, 2900, 4500, 7000];

// bounds: course rect (sim m); hAt(x,y) -> height; baseColor: THREE.Color (linear);
// sea: { level, isSea(x, y) } (sea.js) or null. Where the course edge is sea the apron
// runs down under the water line instead of rising into countryside, so the sea plane
// carries on to the horizon; its edges ease over a few segments into the land's.
export function buildGroundApron({ bounds, hAt, baseColor, segments = 192, sea = null }) {
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const hw = (bounds.maxX - bounds.minX) / 2, hh = (bounds.maxY - bounds.minY) / 2;
  // edge heights + a robust "countryside" base level (median of the edge)
  const edge = [];
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    const t = Math.min(hw / Math.max(1e-9, Math.abs(dx)), hh / Math.max(1e-9, Math.abs(dy)));
    const ex = cx + dx * t, ey = cy + dy * t;
    edge.push({ dx, dy, ex, ey, h: hAt(ex, ey), sea: sea && sea.isSea(ex - dx * 4, ey - dy * 4) ? 1 : 0 });
  }
  const wet = edge.map((_, i) => {
    let s = 0;
    for (let d = -4; d <= 4; d++) s += edge[(i + d + segments) % segments].sea;
    return Math.min(1, (s / 9) * 1.6);
  });
  // (the land's edge only: the sea's would sink the countryside to the water line)
  const land = edge.filter((e) => !e.sea);
  const sorted = (land.length ? land : edge).map((e) => e.h).sort((a, b) => a - b);
  const base = sorted[sorted.length >> 1] - 1.5;
  const nR = RINGS.length;
  const pos = new Float32Array(segments * nR * 3);
  for (let i = 0; i < segments; i++) {
    const e = edge[i];
    for (let r = 0; r < nR; r++) {
      const d = RINGS[r];
      // corners: push outward along the ray from the centre so rings stay convex
      const x = e.ex + e.dx * d, y = e.ey + e.dy * d;
      const w = Math.min(1, d / 260);                         // edge -> countryside blend
      const ease = w * w * (3 - 2 * w);
      const amp = Math.min(38, 0.6 + d * 0.011);               // hills grow with distance
      const hills = (fbm(x * 0.0016 + 3.1, y * 0.0016 - 7.7) - 0.47) * 2.0 * amp
        + (fbm(x * 0.006, y * 0.006) - 0.47) * Math.min(4, d * 0.02);
      let h = r === 0 ? e.h - 0.04 : e.h + (base - e.h) * ease + hills * ease;
      // under the sea: down from the water line, never up out of it
      if (r > 0 && wet[i] > 0) h += (Math.min(h, sea.level - 1.5 - d * 0.004) - h) * wet[i];
      const k = (i * nR + r) * 3;
      pos[k] = x; pos[k + 1] = h; pos[k + 2] = -y;
    }
  }
  const idx = [];
  for (let i = 0; i < segments; i++) {
    const i2 = (i + 1) % segments;
    for (let r = 0; r < nR - 1; r++) {
      const a = i * nR + r, b = i2 * nR + r, c = i * nR + r + 1, d = i2 * nR + r + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // make normals face up regardless of winding
  const n = geo.attributes.normal.array;
  let up = 0; for (let i = 1; i < n.length; i += 3) up += n[i];
  if (up < 0) { idx.reverse(); geo.setIndex(idx); geo.computeVertexNormals(); }

  const mat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 1, metalness: 0, envMapIntensity: 0.25 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApronW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvApronW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vApronW;\n${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 w = vApronW.xz;
          float m1 = hFbm(w * 0.004 + 3.0) - 0.47;          // 250 m fields / patches
          float m2 = hFbm(w * 0.018 - 5.0) - 0.47;          // 50 m mottling
          float m3 = hFbm(w * 0.09 + 1.7) - 0.47;           // 10 m texture near the edge
          float straw = smoothstep(0.52, 0.78, hFbm(w * 0.0025 + 11.0));
          // match the turf shader's processing of unlabelled rough (blade-detail
          // average, warm/cool zone mix, rough darkening, the fescue desaturation) so
          // the apron continues the course ground instead of glowing next to it
          vec3 c = diffuseColor.rgb * 0.88 * vec3(1.03, 1.015, 0.82) * 0.86;
          c *= 1.0 + 0.30 * m1 + 0.14 * m2 + 0.10 * m3;
          c *= mix(vec3(1.0), vec3(1.16, 1.06, 0.74), straw * 0.55);
          // woodlots and tree lines: the countryside around a parkland course is
          // half woods, and a bare green sheet read as a green haze to the horizon
          float woods = smoothstep(0.5, 0.6, hFbm(w * 0.0055 + 21.0)) * smoothstep(120.0, 420.0, length(w - cameraPosition.xz));
          c = mix(c, c * vec3(0.4, 0.48, 0.36), woods * 0.85);
          float L = dot(c, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(c, vec3(L * 0.85) * vec3(1.1, 1.0, 0.8), 0.4);
        }`);
  };
  mat.customProgramCacheKey = () => 'ground-apron-v3';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'groundApron';
  return { mesh, baseHeight: base };
}

// Fog-coloured horizon haze band. Follows the camera horizontally (call update()).
export function buildHorizonHaze({ color, baseHeight = 0, radius = 9500 }) {
  const geo = new THREE.CylinderGeometry(radius, radius, 6000, 64, 1, true);
  geo.translate(0, 1650, 0); // spans y -1350 .. 4650 m
  const uniforms = {
    uColor: { value: color.clone() },
    uBase: { value: baseHeight },
    uFade: { value: radius * Math.tan(THREE.MathUtils.degToRad(7.5)) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying float vH;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vH = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uBase; uniform float uFade;
      varying float vH;
      void main() {
        float t = clamp((vH - uBase) / uFade, 0.0, 1.0);
        float a = 1.0 - smoothstep(0.0, 1.0, pow(t, 0.75));
        gl_FragColor = vec4(uColor, a);
      }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  mesh.name = 'horizonHaze';
  return {
    mesh,
    setColor: (c) => uniforms.uColor.value.copy(c),
    setBase: (h) => { uniforms.uBase.value = h; },
    update: (camera) => { mesh.position.x = camera.position.x; mesh.position.z = camera.position.z; },
  };
}
