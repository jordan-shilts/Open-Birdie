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
// ~15 m swells down to ~1 m chop. Slow: water that moves pulls the eye off the shot.
const RIPPLE = `
  vec3 rippleNormal(vec2 p, float t, float chop) {
    vec2 g = vec2(0.0);
    float freq = 0.42, amp = 0.085, ang = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 d = vec2(cos(ang), sin(ang));
      float ph = dot(d, p) * freq + t * (0.3 + freq * 0.22);
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

function mirrorPond(geom, shared, skip, only) {
  // 512 px: the ripple field distorts the reflection by more than a texel anyway, and a
  // 1024 mirror filled 4x the pixels re-rendering the course every other frame
  const refl = new Reflector(geom, {
    textureWidth: 512, textureHeight: 512, clipBias: 0.003, color: 0xc4d0cc,
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
  // pond's mirror. Ground cover (grass blades, flowers, litter) and the full terrain
  // (`skip`) stay out of the mirror, and a cheap terrain stand-in (`only`) takes the
  // terrain's place: a pond can't show blades or 1 m relief, and redrawing them was
  // most of a mirror's cost.
  const render = refl.onBeforeRender.bind(refl);
  refl.onBeforeRender = (...args) => {
    if (!refl.userData.refresh || inMirror) return;
    refl.userData.refresh = false;
    inMirror = true;
    const hidden = [], shown = [];
    for (const o of skip) if (o.visible) { o.visible = false; hidden.push(o); }
    for (const o of only) if (!o.visible) { o.visible = true; shown.push(o); }
    try { render(...args); } finally {
      inMirror = false;
      for (const o of hidden) o.visible = true;
      for (const o of shown) o.visible = false;
    }
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

// ---------------------------------------------------------------- the sea
// The sea or great lake round a coastal course (sea.js findSea): one plane at its water
// line from the course out to the horizon, cut to the sea by a mask of the terrain grid
// (R: sea, G: metres to land), which past the grid's edge carries on outward, as the
// ground apron does. No mirror: open water mostly shows the sky. Swell and chop run
// with the wind at deep water's speed and fade out as they get finer than a few pixels
// (they would only shimmer), roughening the surface instead; Schlick Fresnel at water's
// 2%; a deep blue body whose wave faces scatter blue-green; shallows that clear over
// sand near the shore; lines of surf running in to the waterline and a wash along it;
// whitecaps in a strong wind; the sun's glitter.
const SHORE_STEP_M = 0.5;   // metres per step of the mask's shore channel (to 127 m)

const SEA_VERT = /* glsl */`
  varying vec3 vWorldPos;
  varying float vEye;
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    vEye = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const SEA_FRAG = /* glsl */`
  uniform float uTime, uWind;
  uniform vec2 uWindDir;          // sim (east, north) the wind blows toward
  uniform vec3 uSunDir, uSunColor, uSeaDeep, uSeaScatter, uSeaShallow;
  uniform sampler2D uSky, uSeaMask;
  uniform vec4 uMaskRect;         // grid corner (sim m, less half a cell); 1 / its width, height
  varying vec3 vWorldPos;
  varying float vEye;
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  float seaHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float seaNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), f.x), mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec3 seaSky(vec3 d) { d.y = abs(d.y); return texture2D(uSky, equirectUv(normalize(d))).rgb; }
  void main() {
    #include <logdepthbuf_fragment>
    vec2 sim = vec2(vWorldPos.x, -vWorldPos.z);
    vec2 uv = (sim - uMaskRect.xy) * uMaskRect.zw;
    vec4 m = texture2D(uSeaMask, clamp(uv, 0.0, 1.0));
    if (m.r < 0.5) discard;
    // past the grid the shore only gets farther
    float shore = m.g * 255.0 * ${SHORE_STEP_M.toFixed(2)} + length(max(max(-uv, uv - 1.0), 0.0) / uMaskRect.zw);
    vec3 V = normalize(cameraPosition - vWorldPos);
    // a pixel's footprint on the water, stretched where the view grazes it
    float foot = vEye * 0.0012 / max(0.05, V.y);
    float wind = clamp(uWind, 0.0, 1.0);
    // swell and chop: waves within about 70 degrees of the wind, longest first, at deep
    // water's speed (w = sqrt(g k)); the chop grows with the wind; each fades out as it
    // gets finer than a few pixels, and what fades roughens the surface instead
    vec2 g = vec2(0.0);
    float rough = 0.0, crest = 0.0, k = 0.09, s = 0.026;
    float base = atan(uWindDir.y, uWindDir.x);
    for (int i = 0; i < 12; i++) {
      float a = base + (fract(float(i) * 0.618034) - 0.5) * 2.4;
      vec2 d = vec2(cos(a), sin(a));
      float ph = dot(d, sim) * k - uTime * 0.7 * sqrt(9.81 * k);
      float amp = s * (i < 3 ? 1.0 : 0.5 + 1.1 * wind);
      float fade = 1.0 - smoothstep(0.8, 2.0, k * foot);
      g += amp * fade * d * cos(ph);
      crest += amp * fade * sin(ph);
      rough += amp * (1.0 - fade);
      k *= 1.42;
      s *= 0.93;
    }
    vec3 N = normalize(vec3(-g.x, 1.0, g.y));   // sim north is world -z
    // Fresnel, less of it where sub-pixel chop shadows and masks the facets
    float F = (0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0)) * (1.0 - 0.45 * clamp(rough * 6.0, 0.0, 1.0));
    // the sky in the waves, softened where the chop is finer than a pixel
    vec3 R = reflect(-V, N);
    vec3 T = normalize(cross(R, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
    float spread = clamp(rough * 3.0, 0.0, 0.5);
    vec3 sky = (seaSky(R) + seaSky(R + T * spread) + seaSky(R - T * spread + vec3(0.0, spread * 0.5, 0.0))) / 3.0;
    float day = 0.35 + 0.65 * clamp(uSunDir.y * 1.6, 0.0, 1.0);
    // the body: deep blue, the faces of the waves scattering blue-green, clearing over
    // the sand within a few tens of metres of the shore
    vec3 body = uSeaDeep * day + uSeaScatter * day * smoothstep(-0.02, 0.1, crest) * 0.45;
    body = mix(body, uSeaShallow * day, exp(-shore / 14.0) * 0.85);
    vec3 col = mix(body, sky, F);
    // the sun's glitter: sharp on near water, a broad sheen where the chop is sub-pixel
    vec3 H = normalize(uSunDir + V);
    float shin = mix(1400.0, 90.0, clamp(rough * 8.0, 0.0, 1.0));
    col += uSunColor * pow(max(dot(N, H), 0.0), shin) * (0.002 * shin + 0.3) * step(0.0, uSunDir.y);
    // surf: broken lines running in to the waterline (bands of shore distance moving
    // shoreward), a wash along it, and whitecaps on the crests in a strong wind
    float zone = 1.0 - smoothstep(2.0, 22.0 + 25.0 * wind, shore);
    float run = sin(shore * 0.5 + uTime * 0.9 + seaNoise(sim * 0.05) * 3.0);
    float br = seaNoise(sim * 0.35 + vec2(uTime * 0.08, 0.0)) * 0.6 + seaNoise(sim * 1.1 - uTime * 0.1) * 0.4;
    float lines = smoothstep(0.86, 0.99, run) * smoothstep(0.45, 0.8, br);
    float wash = (1.0 - smoothstep(0.2, 1.3, shore)) * smoothstep(0.35, 0.7, br);
    float caps = smoothstep(0.45, 1.0, wind) * smoothstep(0.03, 0.09, crest) * smoothstep(0.62, 0.8, seaNoise(sim * 0.09 - uWindDir * uTime * 0.8));
    float foam = clamp(max(max(lines * zone, wash), caps), 0.0, 1.0) * (1.0 - smoothstep(600.0, 2500.0, vEye));
    col = mix(col, vec3(0.82, 0.86, 0.88) * day, foam * 0.8);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

// sea: sea.js findSea; shared: buildWater's live uniforms (time, sun, sky);
// center: sim { x, y } the plane is centred on.
function buildSea(sea, shared, center) {
  const n = sea.nx * sea.ny;
  const data = new Uint8Array(n * 4);
  const half = sea.cellM / 2;
  for (let k = 0; k < n; k++) {
    data[k * 4] = sea.mask[k] ? 255 : 0;
    // the shoreline lies half a cell short of the nearest land cell's centre
    data[k * 4 + 1] = Math.min(255, Math.round(Math.max(0, sea.shoreM[k] - half) / SHORE_STEP_M));
    data[k * 4 + 3] = 255;
  }
  const mask = new THREE.DataTexture(data, sea.nx, sea.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  mask.magFilter = mask.minFilter = THREE.LinearFilter;
  mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
  mask.generateMipmaps = false;
  mask.needsUpdate = true;
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: shared.uTime, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSky: shared.uSky,
    uWind: { value: 0.3 },
    uWindDir: { value: new THREE.Vector2(0, 1) },
    uSeaDeep: { value: new THREE.Color(0x1d5486).convertSRGBToLinear() },
    uSeaScatter: { value: new THREE.Color(0x2c8f94).convertSRGBToLinear() },
    uSeaShallow: { value: new THREE.Color(0x4f9f98).convertSRGBToLinear() },
    uSeaMask: { value: mask },
    uMaskRect: { value: new THREE.Vector4(sea.minX - half, sea.minY - half, 1 / (sea.nx * sea.cellM), 1 / (sea.ny * sea.cellM)) },
  };
  const mat = new THREE.ShaderMaterial({ name: 'Sea', uniforms, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, fog: true });
  mat.userData.disposeTextures = [mask];
  // out past the horizon haze band (9.5 km), inside the camera's far plane
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(9000, 96), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(center.x, sea.level + 0.02, -center.y);
  mesh.receiveShadow = false;
  mesh.name = 'sea';
  // wind: { mph, toDeg } (compass heading it blows toward)
  const setWind = ({ mph = 0, toDeg = 0 } = {}) => {
    uniforms.uWind.value = Math.min(1, mph / 25);
    uniforms.uWindDir.value.set(Math.sin(toDeg * Math.PI / 180), Math.cos(toDeg * Math.PI / 180));
  };
  return { mesh, setWind };
}

// ponds: water-shore.js coursePonds (grown outline + water level per pond);
// sunDir: world Vector3 toward the sun; depth: the terrain depth pre-pass or null;
// sea: sea.js findSea, with seaCenter the sim { x, y } to centre it on, or null.
// Returns { meshes, waterMeshes, sea, waterUpdate, setFoamDepth, setMirrorSkip, setWind }.
export function buildWater(ponds, sunDir, depth, sea = null, seaCenter = null) {
  const meshes = [];
  const mirrorSkip = [];   // objects left out of the live mirrors (setMirrorSkip)
  const mirrorOnly = [];   // objects drawn only inside them
  const reflect = RENDER_CONFIG.waterReflect;
  const shared = {
    uTime: { value: 0 },
    uChop: { value: 0.16 },      // calm until the day's wind says otherwise (setWind)
    uDistort: { value: 0.06 },
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
  const open = sea
    ? buildSea(sea, shared, seaCenter || { x: sea.minX + (sea.nx * sea.cellM) / 2, y: sea.minY + (sea.ny * sea.cellM) / 2 })
    : null;

  for (const p of ponds) {
    // shape in sim (x, y); a -90deg turn about x maps it to three (x, 0, -y) —
    // flipping y first (as this used to) mirrored every pond across the x axis. The
    // turn goes on the MESH, not the geometry: Reflector takes the mirror's normal
    // from the object's +Z (a baked-in turn left it mirroring sideways — black water)
    const shape = new THREE.Shape(p.grown.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ShapeGeometry(shape);
    // a hair over the flattened water line: the bank where it rises out draws the shore
    const level = p.level + 0.03;
    const m = reflect ? mirrorPond(g, shared, mirrorSkip, mirrorOnly) : skyPond(g, shared);
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
  // Returns how many ponds in view are near enough (< 300 m) for their shallows to show:
  // the terrain depth pre-pass behind them redraws the whole terrain, so it runs only
  // then, and the shallows switch off (uDepthOn) on frames it doesn't.
  const SHALLOWS_M = 300;
  const updateMirrors = (camera) => {
    if (!reflect) return meshes.length;
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cand = [];
    let near = 0;
    for (const r of meshes) {
      const sph = r.userData.sphere;
      const d = Math.max(1, sph.center.distanceTo(camera.position) - sph.radius * 0.5);
      if (d < 900 && frustum.intersectsSphere(sph)) {
        cand.push({ r, score: sph.radius / d });
        if (d < SHALLOWS_M) near++;
      } else { r.material.uniforms.uMirror.value = 0; r.userData.live = false; r.userData.refresh = false; }
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
    shared.uDepthOn.value = near && shared.uDepthTex.value ? 1 : 0;
    return near;
  };
  return {
    meshes, waterMeshes: meshes,
    sea: open ? open.mesh : null,
    // the day's wind ({ mph, toDeg }): ponds ruffle with it, the sea runs downwind
    setWind: (wind) => {
      shared.uChop.value = 0.16 + 0.32 * Math.min(1, (wind?.mph || 0) / 25);
      open?.setWind(wind);
    },
    waterUpdate: (t) => { shared.uTime.value = t; },
    setSun: (dir) => shared.uSunDir.value.copy(dir).normalize(),
    setSky: (tex) => { shared.uSky.value = tex; },
    updateMirrors,
    setFoamDepth,
    setMirrorSkip: (objects, only = []) => {
      mirrorSkip.length = 0; mirrorSkip.push(...objects.filter(Boolean));
      mirrorOnly.length = 0; mirrorOnly.push(...only.filter(Boolean));
    },
  };
}
