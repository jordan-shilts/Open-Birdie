// Pin, cloth flag and tee markers.
//
// The flag is a subdivided plane rippled in the vertex shader with a travelling
// wave whose amplitude grows toward the free edge, a slow gust envelope, and
// ANALYTIC normals from the same wave, so the folds actually shade (the old flag
// moved but lit flat). The hole number is printed on both faces. The pin gets a
// white/red banded pole, a ferrule, and a white cup liner.
import * as THREE from 'three';

const FLAG_W = 0.72, FLAG_H = 0.46;

// Wind speed (mph) -> how hard it blows on the cloth, 0..1. A light flag hangs under
// about 2 mph, is half out by 5-6, streams by 10 and is pulled taut past 25.
export function flagWind01(mph) {
  const v = Number.isFinite(mph) ? Math.max(0, mph) : 0;
  return Math.min(1, v / 25);
}

const RED_FLAG = Object.freeze({ cloth: '#d6322f', hem: '#b8282a', ink: '#ffffff' });

function flagTexture(label, colors = RED_FLAG) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = colors.cloth; g.fillRect(0, 0, 256, 160);
  // a slightly darker hem along the pole side
  g.fillStyle = colors.hem; g.fillRect(0, 0, 14, 160);
  if (label) {
    g.fillStyle = colors.ink;
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

// colors: { cloth, hem, ink } for the flag (default red with white numbers; the
// driving range's yardage flags are yellow).
export function makePin(colors = RED_FLAG) {
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
  // how hard the wind blows on the cloth, 0 (calm) .. 1 (a gale): flagWind01 below
  const uWind = { value: flagWind01(8) };
  const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 18, 6);
  flagGeo.translate(FLAG_W / 2, 0, 0); // left edge on the pole
  const flagMat = new THREE.MeshStandardMaterial({ map: flagTexture('', colors), roughness: 0.78, side: THREE.DoubleSide });
  flagMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uWind = uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uWind;
        // The cloth in the wind it is in. Calm: it hangs down the pole in soft folds and
        // barely stirs. A breeze lifts it out and it ripples; a strong wind holds it out
        // straight and it snaps fast. Returns the vertex's offset (x, y, z) and the
        // surface slope (dz/dx in .w; dz/dy is small and folded into the normal below).
        vec4 flagCloth(vec2 p, out float dzdy) {
          float fx = clamp(p.x / ${FLAG_W.toFixed(2)}, 0.0, 1.0);
          float out_ = smoothstep(0.04, 0.42, uWind);            // 0 hanging .. 1 streaming
          float hang = 1.0 - out_;
          float speed = mix(0.35, 1.55, uWind);                  // a gale snaps, a breeze rolls
          float t = uTime * speed;
          float gust = 0.75 + 0.25 * sin(uTime * 0.7) + 0.12 * sin(uTime * 1.9);
          float amp = mix(0.35, 1.25, uWind) * out_;             // ripple height
          float a1 = 0.065 * gust * amp, a2 = 0.035 * gust * amp, a3 = 0.016 * amp;
          float ph1 = fx * 6.2 - t * 7.0, ph2 = fx * 3.1 - t * 4.3;
          float ph3 = fx * 4.0 + p.y * 9.0 - t * 5.5;
          float z = (sin(ph1) * a1 + sin(ph2) * a2 + sin(ph3) * a3) * fx;
          float dzdfx = (cos(ph1) * 6.2 * a1 + cos(ph2) * 3.1 * a2 + cos(ph3) * 4.0 * a3) * fx
                      + (sin(ph1) * a1 + sin(ph2) * a2 + sin(ph3) * a3);
          dzdy = cos(ph3) * 9.0 * a3 * fx;
          float y = sin(fx * 5.0 - t * 6.0) * 0.02 * fx * out_ - fx * fx * 0.035 * (1.2 - gust) * out_; // droops in lulls
          // hanging: the fly end drops and the cloth gathers toward the pole in folds
          // that sway slowly, a little more at the free corner
          float sway = sin(uTime * 0.9 + fx * 2.0) * 0.5 + sin(uTime * 0.37) * 0.5;
          float foldPh = fx * 15.0 + sway * 0.6;
          float foldA = 0.045 * hang;
          z += sin(foldPh) * foldA * fx + sway * 0.03 * hang * fx * fx;
          dzdfx += (cos(foldPh) * 15.0 * foldA * fx + sin(foldPh) * foldA) + sway * 0.06 * hang * fx;
          float gather = 1.0 - 0.7 * hang;                       // how far out the cloth still reaches
          float x = p.x * (gather - 1.0);
          y -= hang * (fx * fx * 0.5 + fx * 0.22) * ${FLAG_W.toFixed(2)};
          return vec4(x, y, z, dzdfx / (${FLAG_W.toFixed(2)} * gather));
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        { float dzdy; vec4 fc = flagCloth(position.xy, dzdy); objectNormal = normalize(vec3(-fc.w, -dzdy, 1.0)); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { float dzdy; vec4 fc = flagCloth(position.xy, dzdy); transformed.xyz += fc.xyz; }`);
  };
  flagMat.customProgramCacheKey = () => 'pin-flag-v3';
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
      flagMat.map = flagTexture(v, colors);
      flagMat.needsUpdate = true;
      old?.dispose();
    },
    // flag streams downwind: rotate the whole pin about its pole
    setWindHeading(rad) { g.rotation.y = rad; },
    // ... and flies as the wind blows: limp in a calm, streaming in a breeze, snapping in a gale
    setWindSpeed(mph) { uWind.value = flagWind01(mph); },
    dispose() {
      g.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        o.material.map?.dispose();
        o.material.dispose();
      });
    },
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
