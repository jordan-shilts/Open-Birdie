// Pond water. Each OSM water polygon becomes a flat plane at the pond's real water
// line, over a bed carved into the render terrain (water-shore.js), grown past the
// hand-traced outline so the bank — where it rises out of the water — draws the
// shore.
//
// High quality: the plane IS a planar mirror (three's Reflector re-renders the scene
// about the pond's level) with its own shader. A mirror re-renders the whole course,
// so only the ponds that matter most on screen (MAX_LIVE_MIRRORS, by size over
// distance) are live, refreshed in turns; the rest mirror the sky photo alone. An analytic ripple field in world XZ
// distorts the mirror and drives the sun glitter; Fresnel mixes the mirror with the
// dark water body (across a pond the trees and sky mirror; looking down you see into
// it); where the terrain depth pre-pass says the water is shallow it clears over the
// silty bed. Fog applies like any other surface.
// Low quality (no mirror): the same shader reflecting the sky photo alone.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RENDER_CONFIG } from './config.js';

// GLSL: sum of directional ripples -> height gradient -> normal. Kept gentle (small
// amplitudes) so the plane reads as calm pond water, not surf. Directions fan out by
// the golden angle so no two waves align (aligned waves read as a mechanical
// crosshatch); frequencies grow by a non-integer ratio (no harmonic moire), from
// ~15 m swells down to ~1 m chop.
const RIPPLE = `
  vec3 rippleNormal(vec2 p, float t, float chop) {
    vec2 g = vec2(0.0);
    float freq = 0.42, amp = 0.085, ang = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 d = vec2(cos(ang), sin(ang));
      float ph = dot(d, p) * freq + t * (0.6 + freq * 0.45);
      g += amp * freq * d * cos(ph);   // dh/dp = A * f * d * cos(phase)
      ang  += 2.39996;
      freq *= 1.53;
      amp  *= 0.62;   // fast falloff: calm water is long swells, not a lattice of chop
    }
    g *= chop;
    return normalize(vec3(-g.x, 1.0, -g.y));
  }
`;

// ---------------------------------------------------------------- mirror ponds
const POND_VERT = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorldPos;
  varying float vEye;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    vEye = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const POND_FRAG = /* glsl */`
  uniform vec3 color;            // mirror tint (set by Reflector)
  uniform sampler2D tDiffuse;    // the mirrored scene
  uniform float uTime, uChop, uDistort;
  uniform vec3 uSunDir, uSunColor, uDeep, uSilt;
  uniform float uDepthOn, uCamNear, uCamFar, uMirror;
  uniform sampler2D uDepthTex, uSky;
  uniform vec2 uResolution;
  varying vec4 vUv;
  varying vec3 vWorldPos;
  varying float vEye;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${RIPPLE}
  void main() {
    #include <logdepthbuf_fragment>
    vec3 N = rippleNormal(vWorldPos.xz, uTime, uChop);
    vec3 V = normalize(cameraPosition - vWorldPos);
    // Schlick Fresnel, floored: a calm pond mirrors well above water's 2% at normal
    // incidence once the sky and banks are bright behind the viewer
    float F = mix(0.22, 1.0, 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0));
    vec4 uv = vUv;
    uv.xy += N.xz * uDistort * uv.w;
    // a live mirror shows the course; the others reflect the sky photo alone
    vec3 mirror = uMirror > 0.5 ? texture2DProj(tDiffuse, uv).rgb * color
                                : texture2D(uSky, equirectUv(reflect(-V, N))).rgb * color;
    // the body: dark, a little green-brown (algae, tannin), lit by the daylight
    vec3 body = uDeep * (0.45 + 0.55 * clamp(uSunDir.y * 1.5, 0.0, 1.0));
    vec3 col = mix(body, mirror, F);
    vec3 H = normalize(uSunDir + V);
    col += uSunColor * pow(max(dot(N, H), 0.0), 380.0) * 3.0 * step(0.0, uSunDir.y);
    float alpha = 1.0;
    if (uDepthOn > 0.5) {
      // water column under this pixel along the view ray (terrain-only depth pre-pass)
      float d = texture2D(uDepthTex, gl_FragCoord.xy / uResolution).x;
      float sceneEye = (uCamNear * uCamFar) / (uCamFar - d * (uCamFar - uCamNear));
      float thick = max(sceneEye - vEye, 0.0);
      float clear = exp(-thick * 1.6);          // the waterline clears; ~1.5 m of water doesn't
      col = mix(col, mix(col, uSilt, 0.35), clear * (1.0 - F));
      alpha = 1.0 - clear * (1.0 - F) * 0.9;
    }
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function mirrorPond(geom, shared) {
  const refl = new Reflector(geom, {
    textureWidth: 1024, textureHeight: 1024, clipBias: 0.003, color: 0xc4d0cc,
    shader: {
      name: 'PondMirror',
      uniforms: {
        color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      },
      vertexShader: POND_VERT,
      fragmentShader: POND_FRAG,
    },
  });
  const m = refl.material;
  // shared live uniforms (time, sun, sky, depth pre-pass) across every pond; uMirror is
  // this pond's own
  Object.assign(m.uniforms, shared, { uMirror: { value: 0 } });
  m.fog = true;
  m.transparent = true;
  refl.receiveShadow = false;
  refl.userData.isWaterReflector = true; // for disposal on course reload
  // Reflector re-renders the scene in onBeforeRender, which fires for EVERY pass that
  // draws the pond (the main pass, the AO normal pass, other ponds' mirrors). Render
  // only when the budget asked for it this frame, once, and never nested in another
  // pond's mirror.
  const render = refl.onBeforeRender.bind(refl);
  refl.onBeforeRender = (...args) => {
    if (!refl.userData.refresh || inMirror) return;
    refl.userData.refresh = false;
    inMirror = true;
    try { render(...args); } finally { inMirror = false; }
  };
  return refl;
}
let inMirror = false;
const MAX_LIVE_MIRRORS = 2;

// ---------------------------------------------------------------- sky-only ponds
// Low graphics: the same pond shader on a plain mesh, never live (uMirror stays 0), so
// it reflects the sky photo with the ripples and glitter at no extra render cost.
function skyPond(geom, shared) {
  const m = new THREE.ShaderMaterial({
    name: 'PondSky',
    uniforms: {
      color: { value: new THREE.Color(0xc4d0cc) }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...shared, uMirror: { value: 0 },
    },
    vertexShader: POND_VERT,
    fragmentShader: POND_FRAG,
    fog: true,
    transparent: true,
  });
  return new THREE.Mesh(geom, m);
}

// ponds: water-shore.js coursePonds (grown outline + water level per pond);
// sunDir: world Vector3 toward the sun; depth: the terrain depth pre-pass or null.
// Returns { meshes, waterMeshes, waterUpdate, setFoamDepth }.
export function buildWater(ponds, sunDir, depth) {
  const meshes = [];
  const reflect = RENDER_CONFIG.waterReflect;
  const shared = {
    uTime: { value: 0 },
    uChop: { value: 0.45 },
    uDistort: { value: 0.09 },
    uSunDir: { value: sunDir.clone().normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.84) },
    uDeep: { value: new THREE.Color(0x14261f).convertSRGBToLinear() },
    uSilt: { value: new THREE.Color(0x4a4532).convertSRGBToLinear() },
    uDepthOn: { value: 0 },
    uSky: { value: null },
    uDepthTex: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCamNear: { value: 0.3 },
    uCamFar: { value: 12000 },
  };

  for (const p of ponds) {
    // shape in sim (x, y); a -90deg turn about x maps it to three (x, 0, -y) —
    // flipping y first (as this used to) mirrored every pond across the x axis. The
    // turn goes on the MESH, not the geometry: Reflector takes the mirror's normal
    // from the object's +Z (a baked-in turn left it mirroring sideways — black water)
    const shape = new THREE.Shape(p.grown.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ShapeGeometry(shape);
    // a hair over the flattened water line: the bank where it rises out draws the shore
    const level = p.level + 0.03;
    const m = reflect ? mirrorPond(g, shared) : skyPond(g, shared);
    m.rotation.x = -Math.PI / 2;
    m.position.y = level;
    m.updateMatrixWorld(true);
    g.computeBoundingSphere();
    m.userData.sphere = g.boundingSphere.clone().applyMatrix4(m.matrixWorld);
    meshes.push(m);
  }

  // Wire the terrain depth pre-pass (its texture/Vector2 are shared refs the helper
  // updates on resize, so this is set once).
  const setFoamDepth = (depthTex, resolution, near, far) => {
    shared.uDepthTex.value = depthTex; shared.uResolution.value = resolution;
    shared.uCamNear.value = near; shared.uCamFar.value = far;
    shared.uDepthOn.value = depthTex && reflect ? 1 : 0;
  };
  if (depth) setFoamDepth(depth.depthTexture, depth.resolution, depth.near, depth.far);
  // Each frame: the ponds most worth a live mirror (in view, within 900 m, biggest
  // for their distance) show it; they take turns re-rendering, a newly promoted one
  // at once (so a single captured frame is complete).
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4();
  let frame = 0;
  // Returns how many ponds are in view (the depth pre-pass is skipped at zero).
  const updateMirrors = (camera) => {
    if (!reflect) return meshes.length;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cand = [];
    for (const r of meshes) {
      const sph = r.userData.sphere;
      const d = Math.max(1, sph.center.distanceTo(camera.position) - sph.radius * 0.5);
      if (d < 900 && frustum.intersectsSphere(sph)) cand.push({ r, score: sph.radius / d });
      else { r.material.uniforms.uMirror.value = 0; r.userData.live = false; r.userData.refresh = false; }
    }
    cand.sort((a, b) => b.score - a.score);
    const n = Math.min(MAX_LIVE_MIRRORS, cand.length);
    frame++;
    cand.forEach(({ r }, i) => {
      const on = i < n;
      r.userData.refresh = on && (!r.userData.live || frame % n === i);
      r.userData.live = on;
      r.material.uniforms.uMirror.value = on ? 1 : 0;
    });
    return cand.length;
  };
  return {
    meshes, waterMeshes: meshes,
    waterUpdate: (t) => { shared.uTime.value = t; },
    setSun: (dir) => shared.uSunDir.value.copy(dir).normalize(),
    setSky: (tex) => { shared.uSky.value = tex; },
    updateMirrors,
    setFoamDepth,
  };
}
