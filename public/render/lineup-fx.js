// Lining up in 3D: yardage arcs draped on the ground ahead of the ball (labelled),
// the club's predicted flight as a dashed gold arc, its roll as a dotted line, the
// ~2-sigma landing zone as a soft gold patch on the terrain, and a "carry" pin over
// the landing spot. Lines are camera-facing ribbons a fixed number of pixels wide, so
// they read the same at 20 m and 250 m. Unlit, no shadows, a handful of draw calls.
import * as THREE from 'three';

const YD = 0.9144;

const LINE_VERT = /* glsl */`
  uniform float uPxWorld;   // world metres per pixel at 1 m (2 tan(fov/2) / viewport h)
  uniform float uPx;        // width in pixels
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aS;       // metres along the line (dashes)
  varying float vSide;
  varying float vS;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 toCam = cameraPosition - wp.xyz;
    float dist = length(toCam);
    vec3 side = cross(aDir, toCam / max(dist, 1e-4));
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    wp.xyz += side * aSide * dist * uPxWorld * uPx * 0.5;
    vSide = aSide;
    vS = aS;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const LINE_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform vec2 uDash;       // dash, gap (m); x = 0: solid
  uniform float uFadeFrom;  // metres along: fade in over the first few metres
  varying float vSide;
  varying float vS;
  void main() {
    float e = 1.0 - abs(vSide);
    float a = smoothstep(0.0, 0.5, e) * uAlpha * smoothstep(0.0, uFadeFrom, vS);
    if (uDash.x > 0.0 && mod(vS, uDash.x + uDash.y) > uDash.x) discard;
    gl_FragColor = vec4(uColor * a, a);
  }`;

function lineMesh(points, { color, alpha = 1, px = 3, dash = [0, 0], fadeFrom = 0.001, order = 10, depthTest = true }) {
  const n = points.length;
  const pos = new Float32Array(n * 6), dir = new Float32Array(n * 6), side = new Float32Array(n * 2), s = new Float32Array(n * 2);
  const d = new THREE.Vector3();
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += points[i].distanceTo(points[i - 1]);
    d.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]);
    if (d.lengthSq() < 1e-10) d.set(1, 0, 0);
    d.normalize();
    for (let k = 0; k < 2; k++) {
      const j = i * 2 + k;
      pos.set([points[i].x, points[i].y, points[i].z], j * 3);
      dir.set([d.x, d.y, d.z], j * 3);
      side[j] = k ? 1 : -1;
      s[j] = acc;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const uniforms = {
    uPxWorld: { value: 0.0015 }, uPx: { value: px },
    uColor: { value: new THREE.Color(color) }, uAlpha: { value: alpha },
    uDash: { value: new THREE.Vector2(dash[0], dash[1]) }, uFadeFrom: { value: fadeFrom },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
    transparent: true, depthWrite: false, depthTest, fog: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = order;
  m.userData.uniforms = uniforms;
  return m;
}

const PATCH_FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uAlpha;
  varying float vR;
  void main() {
    float a = uAlpha * (0.35 + 0.65 * smoothstep(1.0, 0.55, vR)) * (0.75 + 0.25 * smoothstep(0.82, 1.0, vR));
    gl_FragColor = vec4(uColor * a, a);
  }`;

export class LineupFx {
  // scene: THREE.Scene; layer: the DOM label layer over the canvas; hAt(x, y) ground
  // height; V(x, y, z): sim -> three
  constructor(scene, layer, { hAt, V }) {
    this.root = new THREE.Group();
    this.root.name = 'lineupFx';
    scene.add(this.root);
    this.hAt = hAt;
    this.V = V;
    this.layer = layer;
    this.arcs = new THREE.Group();
    this.pred = new THREE.Group();
    this.root.add(this.arcs, this.pred);
    this.labels = [];       // { el, world, kind }
    this._visible = true;
  }

  _clear(group, kind) {
    for (const m of [...group.children]) {
      group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.labels = this.labels.filter((l) => {
      if (l.kind !== kind) return true;
      l.el.remove();
      return false;
    });
  }

  _label(world, html, cls, kind) {
    const el = document.createElement('div');
    el.className = `dist-marker ${cls}`;
    el.innerHTML = html;
    el.style.display = 'none';
    this.layer.appendChild(el);
    this.labels.push({ el, world, kind });
  }

  // a sim-space polyline [[x, y]] draped on the ground, lifted a little
  _drape(pts, lift = 0.22) {
    return pts.map(([x, y]) => this.V(x, y, this.hAt(x, y) + lift));
  }

  // Yardage arcs ahead of the ball along the aim: every 50 y (25 y on short shots) out
  // past the pin or the club's reach, each ~±32 m wide, labelled at the right end.
  setArcs({ ball, aimDeg, reachYd }) {
    this._clear(this.arcs, 'arc');
    if (!ball || !(reachYd > 30)) return;
    const step = reachYd > 160 ? 50 : 25;
    const a0 = aimDeg * Math.PI / 180;
    for (let yd = step; yd <= reachYd + 1e-6; yd += step) {
      const r = yd * YD;
      const half = Math.min(0.42, 32 / r);
      const pts = [];
      const n = Math.max(12, Math.ceil((2 * half * r) / 1.6));
      for (let i = 0; i <= n; i++) {
        const a = a0 - half + (2 * half * i) / n;
        pts.push([ball.x + Math.sin(a) * r, ball.y + Math.cos(a) * r]);
      }
      const major = yd % 50 === 0;
      this.arcs.add(lineMesh(this._drape(pts), { color: 0xffffff, alpha: major ? 0.42 : 0.22, px: major ? 2 : 1.4, order: 9 }));
      if (major) {
        const [x, y] = pts[pts.length - 1];
        this._label(this.V(x, y, this.hAt(x, y) + 0.9), `${yd}`, 'arc', 'arc');
      }
    }
  }

  // The predicted shot (lib/predict.js) or null.
  setPrediction(p) {
    this._clear(this.pred, 'pred');
    if (!p || p.isPutt || !p.path || p.path.length < 2) return;
    // The line is drawn on the ground under the ball's flight: seen from behind, an arc
    // in the air is a spike straight up the screen; on the ground it shows the curve
    // (shape and wind) into the landing zone. The side view carries the height.
    const ft = p.flightTime ?? Infinity;
    const ground = (pts, tEnd) => {
      const out = [];
      for (const q of pts) {
        if (q.t > tEnd + 1e-6) break;
        const last = out[out.length - 1];
        if (!last || Math.hypot(q.x - last[0], q.y - last[1]) >= 1.2) out.push([q.x, q.y]);
      }
      return out;
    };
    const flight = ground(p.path, ft);
    const roll = p.path.filter((q) => q.t >= ft - 1e-6).map((q) => [q.x, q.y]);
    // calm-air ghost, when the conditions move the ball
    const std = p.standard && p.standard.path;
    if (std && std.length > 1 && Math.abs((p.standard.carryYd ?? p.carryYd) - p.carryYd) + Math.abs((p.standard.offlineYd ?? p.offlineYd) - p.offlineYd) > 2) {
      const sp = ground(std, p.standard.flightTime ?? Infinity);
      if (sp.length > 1) this.pred.add(lineMesh(this._drape(sp, 0.2), { color: 0xffffff, alpha: 0.5, px: 2, dash: [1.4, 2.4], fadeFrom: 3, order: 10 }));
    }
    if (flight.length > 1) {
      const pts = this._drape(flight, 0.24);
      this.pred.add(lineMesh(pts, { color: 0xffb81a, alpha: 0.32, px: 8, fadeFrom: 3, order: 11 }));
      this.pred.add(lineMesh(pts, { color: 0xffe27a, alpha: 1, px: 3, dash: [3.2, 2.2], fadeFrom: 3, order: 12 }));
    }
    if (roll.length > 1) this.pred.add(lineMesh(this._drape(roll, 0.18), { color: 0xffd21f, alpha: 0.95, px: 3.2, dash: [0.5, 1.4], order: 12 }));
    // landing zone: a soft gold patch inside the dispersion outline, draped on the ground
    const outline = p.dispersion && p.dispersion.land;
    if (p.land && outline && outline.length >= 6) this.pred.add(this._patch(p.land, outline));
    if (outline && outline.length >= 6) {
      const ring = [...outline, outline[0]].flatMap((q, i, arr) => {
        if (i === 0) return [[q.x, q.y]];
        const a = arr[i - 1], out = [];
        const n = Math.max(1, Math.ceil(Math.hypot(q.x - a.x, q.y - a.y) / 1.5));
        for (let k = 1; k <= n; k++) out.push([a.x + (q.x - a.x) * k / n, a.y + (q.y - a.y) * k / n]);
        return out;
      });
      this.pred.add(lineMesh(this._drape(ring, 0.16), { color: 0xffd21f, alpha: 0.85, px: 2, order: 11 }));
    }
    // the club's lines: its carry (solid) and the short / long edges of where it lands
    if (p.band && p.path.length) {
      const b0 = p.path[0], band = p.band;
      const mid = (band.fromRad + band.toRad) / 2;
      const halfMin = Math.min(0.5, 22 / Math.max(30, band.carryYd * YD));
      const half = Math.max((band.toRad - band.fromRad) / 2 + 0.04, halfMin);
      const arc = (yd) => {
        const r = yd * YD, n = Math.max(10, Math.ceil((2 * half * r) / 1.5)), pts = [];
        for (let i = 0; i <= n; i++) { const a = mid - half + (2 * half * i) / n; pts.push([b0.x + Math.sin(a) * r, b0.y + Math.cos(a) * r]); }
        return pts;
      };
      this.pred.add(lineMesh(this._drape(arc(band.minYd), 0.2), { color: 0xffd21f, alpha: 0.6, px: 2, order: 11 }));
      this.pred.add(lineMesh(this._drape(arc(band.maxYd), 0.2), { color: 0xffd21f, alpha: 0.6, px: 2, order: 11 }));
      this.pred.add(lineMesh(this._drape(arc(band.carryYd), 0.22), { color: 0xffd21f, alpha: 0.95, px: 3, order: 12 }));
      const endAt = (yd) => {
        const a = mid + half, r = yd * YD, x = b0.x + Math.sin(a) * r, y = b0.y + Math.cos(a) * r;
        return this.V(x, y, this.hAt(x, y) + 0.9);
      };
      if (band.maxYd - band.minYd >= 4) {
        this._label(endAt(band.minYd), `${Math.round(band.minYd)}`, 'arc band', 'pred');
        this._label(endAt(band.maxYd), `${Math.round(band.maxYd)}`, 'arc band', 'pred');
      }
    }
    if (p.land) {
      // a small ring on the landing spot
      const pts = [];
      for (let i = 0; i <= 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        pts.push([p.land.x + Math.cos(a) * 1.4, p.land.y + Math.sin(a) * 1.4]);
      }
      this.pred.add(lineMesh(this._drape(pts, 0.14), { color: 0xffffff, alpha: 0.95, px: 2.4, order: 13 }));
      this._label(this.V(p.land.x, p.land.y, this.hAt(p.land.x, p.land.y) + 3.2), `${Math.round(p.carryYd)}<span>y</span>`, 'land', 'pred');
    }
  }

  _patch(center, outline) {
    const rings = 5, segs = 48;
    const pos = [], rr = [], idx = [];
    const at = (u) => {   // outline point at fraction u around (linear between samples)
      const f = u * outline.length, i = Math.floor(f) % outline.length, j = (i + 1) % outline.length, t = f - Math.floor(f);
      return [outline[i].x + (outline[j].x - outline[i].x) * t, outline[i].y + (outline[j].y - outline[i].y) * t];
    };
    const push = (x, y, r) => { const v = this.V(x, y, this.hAt(x, y) + 0.12); pos.push(v.x, v.y, v.z); rr.push(r); };
    push(center.x, center.y, 0);
    for (let k = 1; k <= rings; k++) {
      const f = k / rings;
      for (let s = 0; s < segs; s++) {
        const [ox, oy] = at(s / segs);
        push(center.x + (ox - center.x) * f, center.y + (oy - center.y) * f, f);
      }
    }
    for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + ((s + 1) % segs));
    for (let k = 1; k < rings; k++) {
      const a0 = 1 + (k - 1) * segs, b0 = 1 + k * segs;
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        idx.push(a0 + s, b0 + s, b0 + s1, a0 + s, b0 + s1, a0 + s1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aR', new THREE.Float32BufferAttribute(rr, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffc21a) }, uAlpha: { value: 0.3 } },
      vertexShader: 'attribute float aR; varying float vR; void main(){ vR = aR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: PATCH_FRAG,
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = 8;
    return m;
  }

  // per frame: pixel widths for this camera, visibility, labels projected to the screen
  update(camera, container, visible) {
    if (visible !== this._visible) { this._visible = visible; this.root.visible = visible; }
    const w = container.clientWidth, h = container.clientHeight;
    const pxWorld = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, h);
    for (const g of [this.arcs, this.pred]) for (const m of g.children) if (m.material.uniforms?.uPxWorld) m.material.uniforms.uPxWorld.value = pxWorld;
    const v = new THREE.Vector3();
    const shown = [];
    for (const l of this.labels) {
      if (!visible) { l.el.style.display = 'none'; continue; }
      v.copy(l.world).project(camera);
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      let ok = !(v.z > 1 || sx < 8 || sx > w - 8 || sy < 60 || sy > h - 8);
      if (ok && l.kind === 'arc') for (const p of shown) if (Math.abs(sy - p.y) < 22 && Math.abs(sx - p.x) < 44) { ok = false; break; }
      if (!ok) { l.el.style.display = 'none'; continue; }
      shown.push({ x: sx, y: sy });
      l.el.style.display = '';
      l.el.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
  }

  dispose() {
    this._clear(this.arcs, 'arc');
    this._clear(this.pred, 'pred');
    this.root.parent?.remove(this.root);
  }
}
