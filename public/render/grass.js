// Instanced fescue/rough grass — tapered geometry blades (green base -> golden tip)
// scattered on the rough, with a vertex-shader wind. The wispy long grass that
// frames a hole. Geometry blades (no alpha texture), GPU-instanced.
import * as THREE from 'three';
import { RENDER_CONFIG } from './config.js';

function mul32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One blade: a tapered strip, base at y=0, 1 unit tall (scaled per instance).
// Vertex color runs base -> tip. Defaults = the golden fescue; opts let the
// fairway variant pass short-green colors, a wider base, and fewer segments.
function bladeGeometry(opts = {}) {
  const segs = opts.segs ?? 3, h = 1.0, baseW = opts.baseWidth ?? 0.024;
  const pos = [], col = [], idx = [];
  const base = new THREE.Color(opts.colorBase ?? 0x53703a), tip = new THREE.Color(opts.colorTip ?? 0xc2b06a), c = new THREE.Color();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, y = t * h, w = baseW * (1 - 0.85 * t);
    pos.push(-w, y, 0, w, y, 0);
    c.copy(base).lerp(tip, t * t);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Vertex-shader wind sway + optional camera-distance fade. The fade collapses each
// blade to zero size past a camera radius (length of its view-space origin), so a static
// instanced field reads as a camera-anchored FOREGROUND patch — blades exist only where
// they actually resolve at the orbit camera, and cost ~nothing (no fragments) elsewhere.
function addBladeShader(material, refs, opts = {}) {
  const wind = opts.wind !== false;
  const fade = opts.fade || null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    refs.push(shader.uniforms.uTime);
    let header = '#include <common>\nuniform float uTime;';
    if (fade) { header += '\nuniform vec2 uFade;'; shader.uniforms.uFade = { value: new THREE.Vector2(fade.near, fade.far) }; }
    let body = '#include <begin_vertex>';
    if (fade) body += `
        {
          vec4 ivp = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float fk = 1.0 - smoothstep(uFade.x, uFade.y, length(ivp.xyz));
          transformed *= fk; // collapse blades past the fade radius -> camera-anchored foreground
        }`;
    if (wind) body += `
        {
          float ph = float(gl_InstanceID) * 0.613;
          float t = transformed.y; // 0..1 up the blade (post-fade scale)
          transformed.x += (sin(uTime * 1.6 + ph) * 0.10 + sin(uTime * 3.1 + ph * 1.7) * 0.04) * t;
          transformed.z += cos(uTime * 1.3 + ph) * 0.06 * t;
        }`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', header)
      // lit like the ground the blades grow from: a flat strip's own normal shades it
      // black whenever it faces away from the sun
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(vec3(normal) * 0.25 + vec3(0.0, 1.0, 0.0));')
      .replace('#include <begin_vertex>', body);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal); nonPerturbedNormal = normal;');
  };
  material.customProgramCacheKey = () => `grass-up-${wind ? 'w' : ''}${fade ? 'f' : ''}`;
}

// spots: [{x,y,s}], hAt, V, opts. Returns { mesh, windUpdate, cull }.
// opts (all optional, defaults = the rough fescue): {perTuft, height, baseWidth,
// segs, colorBase, colorTip, wind, jitter, seed, cellM}.
// cellM: split the tufts into square cells of that size, one instanced mesh each (mesh is
// then a Group of them): three culls the cells off screen, and cull(camera, drawM) hides
// the ones farther than drawM. As one mesh, every blade on the course went through the
// vertex shader every frame: ~1 M triangles at Whistling Straits on Low graphics, as much
// as all its trees, for blades a pixel tall a few hundred metres out.
export function buildGrass(spots, hAt, V, opts = {}) {
  if (!spots.length) return { mesh: null, windUpdate: () => {}, cull: () => {} };
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 1.0, metalness: 0,
  });
  const refs = [];
  const wind = opts.wind !== false;
  const fade = opts.cameraFade || null;
  if (wind || fade) addBladeShader(mat, refs, { wind, fade });
  const PER = opts.perTuft ?? 12; // blades per tuft — a dense clump reads, a lone blade doesn't
  // Per-instance zone tint (opts.colorAt): bake a neutral base->tip BRIGHTNESS gradient into
  // the blade (dark base = the inter-blade micro-shadow the flat turf lacks, lit tip =
  // sun-catch) and let instanceColor carry each blade's surface-zone HUE, so the layer reads
  // matched to the turf underneath instead of a carpet glued on top.
  const tint = opts.colorAt || null;
  const geoOpts = tint
    ? { ...opts, colorBase: new THREE.Color(0.86, 0.86, 0.86), colorTip: new THREE.Color(1.12, 1.12, 1.12) }
    : opts;
  const blade = bladeGeometry(geoOpts);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), scaleVec = new THREE.Vector3();
  const rnd = mul32(opts.seed ?? 8081);
  const H = opts.height ?? RENDER_CONFIG.grassHeight;
  const jit = opts.jitter ?? 0.28;
  const cellM = opts.cellM > 0 ? opts.cellM : 0;
  let buckets = [spots];
  if (cellM) {
    const byCell = new Map();
    for (const sp of spots) {
      const k = `${Math.floor(sp.x / cellM)},${Math.floor(sp.y / cellM)}`;
      (byCell.get(k) || byCell.set(k, []).get(k)).push(sp);
    }
    buckets = [...byCell.values()];
  }
  const meshes = buckets.map((list) => {
    const mesh = new THREE.InstancedMesh(blade, mat, list.length * PER);
    mesh.castShadow = false;   // blade shadows are expensive + low value at this density
    mesh.receiveShadow = true;
    let bi = 0;
    for (const sp of list) {
      for (let k = 0; k < PER; k++) {
        const x = sp.x + (rnd() - 0.5) * jit, y = sp.y + (rnd() - 0.5) * jit;
        const h = hAt(x, y);
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        const sc = H * (0.6 + rnd() * 0.9) * (sp.s || 1);
        scaleVec.set(sc * (0.8 + rnd() * 0.5), sc, sc);
        m4.compose(V(x, y, h), q, scaleVec);
        mesh.setMatrixAt(bi, m4);
        if (tint) { const c = tint(x, y); if (c) mesh.setColorAt(bi, c); }
        bi++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();   // the cell's own bounds: off-screen cells are culled
    return mesh;
  });
  let mesh = meshes[0];
  if (meshes.length > 1) {
    mesh = new THREE.Group();
    mesh.name = 'grassCells';
    meshes.forEach((m) => mesh.add(m));
  }
  const cull = (camera, drawM = Infinity) => {
    if (meshes.length < 2) return;
    const p = camera.position;
    for (const m of meshes) {
      const bs = m.boundingSphere;
      m.visible = !bs || bs.center.distanceTo(p) - bs.radius < drawM;
    }
  };
  return { mesh, windUpdate: (t) => { for (const u of refs) u.value = t; }, cull };
}
