// Pin, cloth flag and tee markers.
//
// The flag is a subdivided plane rippled in the vertex shader with a travelling
// wave whose amplitude grows toward the free edge, a slow gust envelope, and
// ANALYTIC normals from the same wave, so the folds actually shade (the old flag
// moved but lit flat). The hole number is printed on both faces. The pin gets a
// white/red banded pole, a ferrule, and a white cup liner.
import * as THREE from 'three';

const FLAG_W = 0.72, FLAG_H = 0.46;

function flagTexture(label) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = '#d6322f'; g.fillRect(0, 0, 256, 160);
  // a slightly darker hem along the pole side
  g.fillStyle = '#b8282a'; g.fillRect(0, 0, 14, 160);
  if (label) {
    g.fillStyle = '#ffffff';
    g.font = 'bold 104px "Bahnschrift", "DIN Alternate", "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(label), 136, 86);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function poleTexture() {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 128;
  const g = cv.getContext('2d');
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f4f1e8' : '#c9302c'; g.fillRect(0, i * 16, 8, 16); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makePin() {
  const g = new THREE.Group();
  g.name = 'pin';
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.019, 0.022, 2.3, 10),
    new THREE.MeshStandardMaterial({ map: poleTexture(), roughness: 0.45, metalness: 0 }),
  );
  pole.position.y = 1.15;
  pole.castShadow = true;
  const ferrule = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10),
    new THREE.MeshStandardMaterial({ color: 0xc9c4b6, roughness: 0.3, metalness: 0.8 }),
  );
  ferrule.position.y = 0.02;
  const uTime = { value: 0 };
  const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 18, 6);
  flagGeo.translate(FLAG_W / 2, 0, 0); // left edge on the pole
  const flagMat = new THREE.MeshStandardMaterial({ map: flagTexture(''), roughness: 0.78, side: THREE.DoubleSide });
  flagMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        // travelling wave + gust; returns displacement (z, y) and dz/dx, dz/dy
        vec4 flagWave(vec2 p) {
          float fx = clamp(p.x / ${FLAG_W.toFixed(2)}, 0.0, 1.0);
          float gust = 0.75 + 0.25 * sin(uTime * 0.7) + 0.12 * sin(uTime * 1.9);
          float a1 = 0.065 * gust, a2 = 0.035 * gust, a3 = 0.016;
          float ph1 = fx * 6.2 - uTime * 7.0, ph2 = fx * 3.1 - uTime * 4.3;
          float ph3 = fx * 4.0 + p.y * 9.0 - uTime * 5.5;
          float z = (sin(ph1) * a1 + sin(ph2) * a2 + sin(ph3) * a3) * fx;
          float dzdfx = (cos(ph1) * 6.2 * a1 + cos(ph2) * 3.1 * a2 + cos(ph3) * 4.0 * a3) * fx
                      + (sin(ph1) * a1 + sin(ph2) * a2 + sin(ph3) * a3);
          float dzdx = dzdfx / ${FLAG_W.toFixed(2)};
          float dzdy = cos(ph3) * 9.0 * a3 * fx;
          float y = sin(fx * 5.0 - uTime * 6.0) * 0.02 * fx - fx * fx * 0.035 * (1.2 - gust); // droops in lulls
          return vec4(z, y, dzdx, dzdy);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        { vec4 fw = flagWave(position.xy); objectNormal = normalize(vec3(-fw.z, -fw.w, 1.0)); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec4 fw = flagWave(position.xy); transformed.z += fw.x; transformed.y += fw.y; }`);
  };
  flagMat.customProgramCacheKey = () => 'pin-flag-v2';
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0.012, 2.06, 0);
  flag.castShadow = true;
  // cup: white liner ring + dark hole
  const liner = new THREE.Mesh(
    new THREE.RingGeometry(0.105, 0.125, 24),
    new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  liner.rotation.x = -Math.PI / 2;
  liner.position.y = 0.021;
  const hole = new THREE.Mesh(
    new THREE.CircleGeometry(0.106, 24),
    new THREE.MeshBasicMaterial({ color: 0x0b0b0b, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  hole.rotation.x = -Math.PI / 2;
  hole.position.y = 0.02;
  g.add(pole, ferrule, flag, liner, hole);
  let label = null;
  return {
    group: g,
    uTime,
    // print the hole number on the flag (no-op when unchanged)
    setLabel(text) {
      const v = text == null ? '' : String(text);
      if (v === label) return;
      label = v;
      const old = flagMat.map;
      flagMat.map = flagTexture(v);
      flagMat.needsUpdate = true;
      old?.dispose();
    },
    // flag streams downwind: rotate the whole pin about its pole
    setWindHeading(rad) { g.rotation.y = rad; },
  };
}

// Two tee markers either side of the teeing spot, a step ahead of the ball.
export function makeTeeMarkers(color = 0x2f5fd0) {   // blue (back) tees; reads apart from the white ball
  const g = new THREE.Group();
  g.name = 'teeMarkers';
  const geo = new THREE.SphereGeometry(0.13, 16, 10);
  geo.translate(0, 0.09, 0);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0 });
  const capGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.04, 12);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.6 });
  const markers = [0, 1].map(() => {
    const m = new THREE.Group();
    const ball = new THREE.Mesh(geo, mat);
    ball.castShadow = true;
    const base = new THREE.Mesh(capGeo, capMat);
    base.position.y = 0.0;
    m.add(ball, base);
    g.add(m);
    return m;
  });
  return {
    group: g,
    // tee/aim in sim frame; hAt(x,y); V: sim->three
    place(tee, aimDeg, hAt, V) {
      const a = aimDeg * Math.PI / 180;
      const fx = Math.sin(a), fy = Math.cos(a);
      const rx = fy, ry = -fx;
      markers.forEach((m, i) => {
        const side = i ? 1 : -1;
        const x = tee[0] + fx * 1.4 + rx * 3.2 * side, y = tee[1] + fy * 1.4 + ry * 3.2 * side;
        m.position.copy(V(x, y, hAt(x, y)));
      });
      g.visible = true;
    },
    hide() { g.visible = false; },
  };
}
