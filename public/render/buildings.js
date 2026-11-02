// 3D buildings: roof shapes and walls from building-shapes.js, merged into two
// meshes (all walls, all roofs), so 250 buildings cost two draw calls.
//
// Walls: a facade shader lays out storeys of windows (sill, head, frames, the odd
// blank bay) from each wall's own (along-wall, height) coordinates, a darker
// foundation band and faint lap-siding courses; glass is smooth and a little
// metallic so it catches the sky. The pattern fades to its average with distance so
// it never shimmers. Siding colours vary per building (vertex colour).
// Roofs: coloured from the course's aerial photo straight above them — the real
// shingles, membranes and skylights — over a per-building fallback colour, with
// shingle courses (lines of constant height) for close views.
import * as THREE from 'three';
import { buildingMeshData } from './building-shapes.js';

const lin = (hex) => new THREE.Color(hex).toArray();
// siding / brick / stucco, and asphalt / cedar / metal roofs (sRGB hex -> linear)
const WALLS = ['#e9e5dc', '#ddd3c0', '#c4bfb5', '#cbbb9c', '#aeb8bb', '#9a6b54', '#7d6553', '#d7cdb8'].map(lin);
const ROOFS = ['#3f4043', '#4d4640', '#5a5853', '#35383c', '#5c4a3d', '#6b6a66'].map(lin);

function geometry(d, withWall) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
  if (withWall) g.setAttribute('aWall', new THREE.Float32BufferAttribute(d.wall, 4));
  return g;
}

function wallMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWall;\nvarying vec4 vWall;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vWall;
        float gGlass;
        float bHash(float n) { return fract(sin(n * 91.7) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec4 w = vWall;                         // along wall, height, wall length, eave height (m)
          float storey = 3.1;
          float fl = floor(w.y / storey), fv = w.y - fl * storey;
          float bays = max(1.0, floor(w.z / 3.3));
          float bayW = w.z / bays;
          float bay = floor(w.x / bayW), bu = w.x - bay * bayW - bayW * 0.5;
          float open = step(0.24, bHash(bay * 7.0 + fl * 13.0 + w.z * 0.37));   // the odd blank bay
          float win = step(abs(bu), 0.66) * step(0.92, fv) * step(fv, 2.28)
                    * step(w.y, w.w - 0.4) * step(0.0, w.y) * step(2.6, w.z) * open;
          float pane = win * step(abs(bu), 0.58) * step(1.0, fv) * step(fv, 2.2);
          // the pattern averages out with distance instead of shimmering
          float far = smoothstep(0.08, 0.3, fwidth(w.x) + fwidth(w.y));
          vec3 sid = diffuseColor.rgb * (1.0 - 0.07 * smoothstep(0.82, 1.0, fract(w.y / 0.21)) * (1.0 - win));
          vec3 facade = mix(sid, vec3(0.86), win - pane);                      // white frames
          facade = mix(facade, vec3(0.035, 0.04, 0.045), pane);                // glass
          vec3 avg = diffuseColor.rgb * 0.8;
          diffuseColor.rgb = mix(facade, avg, far);
          diffuseColor.rgb *= mix(0.52, 1.0, smoothstep(0.25, 0.45, w.y));   // foundation band
          gGlass = pane * (1.0 - far);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, gGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.55, gGlass);');
  };
  m.customProgramCacheKey = () => 'building-walls-v1';
  return m;
}

// aerial: { albedo: texture, bounds: { minX, minY, maxX, maxY } } (sim metres) or null
function roofMaterial(aerial) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
  const uniforms = {
    uAerial: { value: aerial?.albedo || null },
    uAerialMin: { value: new THREE.Vector2(aerial?.bounds.minX || 0, aerial?.bounds.minY || 0) },
    uAerialSize: { value: new THREE.Vector2((aerial?.bounds.maxX - aerial?.bounds.minX) || 1, (aerial?.bounds.maxY - aerial?.bounds.minY) || 1) },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoofW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoofW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRoofW;
        ${aerial ? 'uniform sampler2D uAerial; uniform vec2 uAerialMin, uAerialSize;' : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          ${aerial ? `
          // the real roof, straight down in the aerial photo
          vec2 uv = (vec2(vRoofW.x, -vRoofW.z) - uAerialMin) / uAerialSize;
          if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
            vec3 photo = texture2D(uAerial, uv, 1.0).rgb;
            // a tree overhanging the roof (or the photo's lean on a tall building)
            // shows foliage, not roof: keep the building's own roof colour there
            float leafy = smoothstep(0.01, 0.05, photo.g - max(photo.r, photo.b));
            diffuseColor.rgb = mix(diffuseColor.rgb, photo * 1.05, 0.8 * (1.0 - leafy));
          }` : ''}
          // shingle courses run at constant height (flat roofs stay smooth)
          float course = smoothstep(0.78, 1.0, fract(vRoofW.y / 0.15)) * (1.0 - smoothstep(0.02, 0.08, fwidth(vRoofW.y)));
          diffuseColor.rgb *= 1.0 - 0.18 * course;
        }`);
  };
  m.customProgramCacheKey = () => `building-roofs-v2${aerial ? '-aerial' : ''}`;
  return m;
}

// buildings: geo.buildings; hAt: scene.hAt; aerial: the course aerial (or null).
// Returns { meshes, count }.
export function buildBuildings(buildings, hAt, aerial = null) {
  const d = buildingMeshData(buildings, hAt, {
    wallColors: WALLS, roofColors: ROOFS, heroWall: lin('#d9ccb4'), heroRoof: lin('#3b3d40'),
  });
  if (!d.count) return { meshes: [], count: 0 };
  const walls = new THREE.Mesh(geometry(d.walls, true), wallMaterial());
  const roofs = new THREE.Mesh(geometry(d.roofs, false), roofMaterial(aerial));
  for (const m of [walls, roofs]) { m.castShadow = true; m.receiveShadow = true; }
  walls.name = 'buildingWalls'; roofs.name = 'buildingRoofs';
  return { meshes: [walls, roofs], count: d.count };
}
