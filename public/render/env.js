// HDRI environment: image-based lighting (PMREM), visible sky background, a
// ground-projected horizon, and the directional sun derived from the HDRI.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { sunSphericalFromEquirect, sunDirectionVec, horizonColorFromEquirect, horizonLinearFromEquirect, clampEquirectRadiance } from './hdri-analyze.js';
import { RENDER_CONFIG } from './config.js';
import { ASSETS } from './assets.js';

// pure math lives in hdri-analyze (unit-tested for handedness, D3); wrap as Vector3 here
const sunVec = (azimuth, altitude) => {
  const v = sunDirectionVec(azimuth, altitude);
  return new THREE.Vector3(v.x, v.y, v.z).normalize();
};

// Loads HDRI, returns { envTexture (PMREM, for scene.environment),
// equirect (for scene.background + skybox), sunDir, horizonColor }.
// url defaults to the bundled sky; a sun axis given as null comes from the photo.
export async function loadHDRIEnvironment(renderer, {
  url = ASSETS.hdri(), sunAzimuthDeg = RENDER_CONFIG.sunAzimuthDeg, sunAltitudeDeg = RENDER_CONFIG.sunAltitudeDeg,
} = {}) {
  const equirect = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(url);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  const { data, width, height } = equirect.image;
  // sun direction: each config override (D2) wins on its own axis, else the HDRI's
  // estimate — so the altitude can be set (long, crisp shadows) while the azimuth
  // still follows the sky's bright side. Read from the photo as shot, before the clamp
  // below levels the sun disc's brightest texels.
  const ovAz = sunAzimuthDeg, ovAlt = sunAltitudeDeg;
  const est = (ovAz != null && ovAlt != null) ? null : sunSphericalFromEquirect(data, width, height);
  // keep the sun disc inside half-float range before the GPU sees it (hdri-analyze.js)
  if (clampEquirectRadiance(data)) equirect.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();

  const sph = {
    azimuth: ovAz != null ? THREE.MathUtils.degToRad(ovAz) : est.azimuth,
    altitude: ovAlt != null ? THREE.MathUtils.degToRad(ovAlt) : est.altitude,
  };
  const sunDir = sunVec(sph.azimuth, Math.max(sph.altitude, THREE.MathUtils.degToRad(8))); // floor so shadows read
  const horizonColor = horizonColorFromEquirect(data, width, height);
  const hl = horizonLinearFromEquirect(data, width, height);
  const horizonLinear = new THREE.Color().setRGB(hl.r, hl.g, hl.b, THREE.LinearSRGBColorSpace);
  return { envTexture, equirect, sunDir, horizonColor, horizonLinear };
}

// Directional key light. Given an initial aim along sunDir; _fitShadows refines
// position/frustum per hole. (Direction = sun.position - sun.target; target at origin.)
export function makeSun(sunDir) {
  const sun = new THREE.DirectionalLight(0xfff4e0, RENDER_CONFIG.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.35;
  sun.position.copy(sunDir).multiplyScalar(700); // initial aim before first _fitShadows
  return sun;
}

// Ground-projected HDRI dome so the horizon meets the course edge.
// radius/height derived from course bounds (sim meters).
export function makeGroundedSkybox(equirect, bounds) {
  const spanX = bounds.maxX - bounds.minX, spanY = bounds.maxY - bounds.minY;
  const radius = Math.max(spanX, spanY) * 1.6 + 600;
  const height = RENDER_CONFIG.skyboxHeight; // projection height; tuned in Task 7
  const sky = new GroundedSkybox(equirect, height, radius);
  // REQUIRED: GroundedSkybox flattens its lower hemisphere to local y = -height;
  // lifting by +height puts the projected ground at world y ≈ 0 (the course plane).
  sky.position.y = height;
  sky.name = 'groundedSky';
  return sky;
}

// Neutral fallback env if the HDRI fails to load (D1). Without it, removing the
// Preetham sky leaves PBR materials with no ambient and shadowed areas go near-black.
export function makeFallbackEnv(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return tex;
}
