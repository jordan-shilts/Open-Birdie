// Building shapes from OSM footprints: roof type, roof faces and walls as plain
// vertex arrays. Pure (no three, no DOM) so it is unit-tested
// (test/building-shapes.test.mjs); buildings.js turns it into meshes.
//
// Roofs: a near-rectangular house gets a gabled or hipped roof along its long axis
// (the footprint's minimum-area rectangle), pitched 30-38 deg with an eave overhang.
// An L-shaped or irregular footprint gets a hip roof made by insetting the outline —
// each wall's roof face rises to the inset outline, flat on top (a stand-in for a
// straight skeleton that never self-intersects). Big commercial and school blocks,
// and anything too irregular to inset, get a flat roof behind a parapet.
// Walls carry (along-wall, height-above-ground, wall length, eave height) so the
// facade shader can lay out storeys of windows.
//
// Output positions are three.js world space: sim (x, y, z) -> (x, z, -y).

export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

const ccw = (poly) => (signedArea(poly) >= 0 ? poly : poly.slice().reverse());

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Minimum-area enclosing rectangle (it shares a side with the convex hull):
// { cx, cy, ux, uy (unit long axis), L (long side), W (short side) }.
export function minAreaRect(poly) {
  const hull = convexHull(poly);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const dl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (dl < 1e-9) continue;
    const ux = (b[0] - a[0]) / dl, uy = (b[1] - a[1]) / dl;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy, v = -x * uy + y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uy, u0, u1, v0, v1 };
  }
  const { ux, uy, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let r = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, ux, uy, L: u1 - u0, W: v1 - v0 };
  if (r.W > r.L) r = { ...r, ux: -uy, uy: ux, L: r.W, W: r.L };   // long axis first
  return r;
}

// Shrink a simple polygon by d (vertex-normal offset, miter capped). null when the
// result folds over itself (an arm narrower than 2d) or degenerates.
export function insetPolygon(poly0, d) {
  const poly = ccw(poly0);
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n], c = poly[i], q = poly[(i + 1) % n];
    const e1 = unit(c[0] - p[0], c[1] - p[1]), e2 = unit(q[0] - c[0], q[1] - c[1]);
    const n1 = [-e1[1], e1[0]], n2 = [-e2[1], e2[0]];   // inward (left of a CCW edge)
    const m = unit(n1[0] + n2[0], n1[1] + n2[1]);
    const cos = m[0] * n1[0] + m[1] * n1[1];
    if (cos < 0.35) return null;                          // a spike: no clean inset
    out.push([c[0] + m[0] * (d / cos), c[1] + m[1] * (d / cos)]);
  }
  const a0 = signedArea(poly), a1 = signedArea(out);
  if (!(a1 > a0 * 0.04)) return null;
  // every inset edge must stay parallel to (not flip against) its source edge
  for (let i = 0; i < n; i++) {
    const s = [poly[(i + 1) % n][0] - poly[i][0], poly[(i + 1) % n][1] - poly[i][1]];
    const t = [out[(i + 1) % n][0] - out[i][0], out[(i + 1) % n][1] - out[i][1]];
    if (s[0] * t[0] + s[1] * t[1] <= 0) return null;
  }
  return out;
}
function unit(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

function hash(x, y) { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); }

// OSM outlines repeat their first point, stack near-duplicates and carry collinear
// vertices: drop all three (a zero-length edge has no direction to inset along).
export function cleanPolygon(poly) {
  let p = poly.filter((v, i) => i === 0 || Math.hypot(v[0] - poly[i - 1][0], v[1] - poly[i - 1][1]) > 0.25);
  while (p.length > 3 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) <= 0.25) p = p.slice(0, -1);
  for (let changed = true; changed && p.length > 3;) {
    changed = false;
    for (let i = 0; i < p.length && p.length > 3; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const e1 = unit(b[0] - a[0], b[1] - a[1]), e2 = unit(c[0] - b[0], c[1] - b[1]);
      if (e1[0] * e2[0] + e1[1] * e2[1] > 0.985) { p.splice(i, 1); changed = true; break; }   // < ~10 deg turn
    }
  }
  return p;
}

// Douglas-Peucker on a closed outline: the roof is pitched over the building's
// main mass, so jogs and bays smaller than tol (m) are smoothed away for it.
export function simplifyPolygon(poly, tol) {
  if (poly.length <= 4) return poly.slice();
  let i0 = 0, i1 = 0, far = -1;
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
    const d = Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
    if (d > far) { far = d; i0 = i; i1 = j; }
  }
  const dp = (pts) => {
    if (pts.length <= 2) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let k = -1, dmax = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
      if (d > dmax) { dmax = d; k = i; }
    }
    if (dmax <= tol) return [a, b];
    const left = dp(pts.slice(0, k + 1)), right = dp(pts.slice(k));
    return left.slice(0, -1).concat(right);
  };
  const ring1 = poly.slice(i0, i1 + 1), ring2 = poly.slice(i1).concat(poly.slice(0, i0 + 1));
  const out = dp(ring1).slice(0, -1).concat(dp(ring2).slice(0, -1));
  return out.length >= 3 && Math.abs(signedArea(out)) > Math.abs(signedArea(poly)) * 0.7 ? out : poly.slice();
}

// Ear-clipping triangulation of a simple polygon -> index triples (flat roofs,
// slabs and the crown of an inset roof can be L-shaped: a fan would spill out).
export function triangulate(poly0) {
  const poly = ccw(poly0);
  const idx = poly.map((_, i) => i);
  const tris = [];
  const isConvex = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
  const inside = (p, a, b, c) => {
    const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
    const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (!isConvex(a, b, c)) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(poly[j], a, b, c))) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;   // degenerate outline: fan the rest
  }
  for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
  return { poly, tris };
}

const RESIDENTIAL = new Set(['house', 'detached', 'terrace', 'residential', 'semidetached_house', 'bungalow', 'garage', 'garages', 'shed', 'yes', 'cabin', 'farm']);
const FLAT_KINDS = new Set(['commercial', 'retail', 'school', 'industrial', 'warehouse', 'office', 'hospital', 'supermarket', 'university', 'college', 'apartments']);

// { type: 'gable' | 'hip' | 'inset' | 'flat' | 'canopy', pitchDeg, overhang, rect }
export function roofPlan(b) {
  const poly = ccw(cleanPolygon(b.poly));
  const area = signedArea(poly);
  const rect = minAreaRect(poly);
  const fill = area / Math.max(1e-6, rect.L * rect.W);
  const h = hash(rect.cx, rect.cy);
  if (b.kind === 'roof' || b.kind === 'carport') return { type: 'canopy', pitchDeg: 0, overhang: 0, rect };
  if (!b.clubhouse && (FLAT_KINDS.has(b.kind) || area > 1800)) return { type: 'flat', pitchDeg: 0, overhang: 0, rect };
  const pitchDeg = b.clubhouse ? 26 : 30 + h * 8;
  if (!b.clubhouse && RESIDENTIAL.has(b.kind) && fill > 0.82 && area < 700) {
    return { type: rect.L / rect.W > 1.25 && h < 0.62 ? 'gable' : 'hip', pitchDeg, overhang: 0.45, rect };
  }
  return { type: 'inset', pitchDeg, overhang: b.clubhouse ? 0.8 : 0.45, rect };
}

// Build the vertex data for every building. hAt(x, y) -> ground height.
// Returns { walls: { pos, nor, wall, col }, roofs: { pos, nor, col }, count }.
export function buildingMeshData(buildings, hAt, { wallColors, roofColors, heroWall, heroRoof } = {}) {
  const W = { pos: [], nor: [], wall: [], col: [] };
  const R = { pos: [], nor: [], col: [] };
  let count = 0;
  const P = (x, y, z) => [x, z, -y];

  // one triangle with an outward-facing check: `out` is any vector the face should face
  const tri = (M, a, b, c, n, out, extra) => {
    const fx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const fy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const fz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const flip = fx * out[0] + fy * out[1] + fz * out[2] < 0;
    const vs = flip ? [a, c, b] : [a, b, c];
    const ex = extra ? (flip ? [extra[0], extra[2], extra[1]] : extra) : null;
    vs.forEach((v, k) => {
      M.pos.push(v[0], v[1], v[2]); M.nor.push(n[0], n[1], n[2]);
      if (ex) M.wall.push(...ex[k]);
      M.col.push(...M.c);
    });
  };
  const faceNormal = (a, b, c, out) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
    return n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0 ? n.map((x) => -x) : n;
  };
  // a roof face polygon (convex, three-space points), facing up/out
  const roofFace = (pts) => {
    if (pts.length < 3) return;
    const n = faceNormal(pts[0], pts[1], pts[2], [0, 1, 0]);
    for (let i = 1; i < pts.length - 1; i++) tri(R, pts[0], pts[i], pts[i + 1], n, n);
  };
  // a wall quad / triangle between ground-level base and points above it
  const wallFace = (a, b, zBot, topA, topB, ground, eaveV, out) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) return;
    const A = P(a[0], a[1], zBot), B = P(b[0], b[1], zBot), C = P(b[0], b[1], topB), D = P(a[0], a[1], topA);
    const n = [out[0], 0, -out[1]];
    const w = (u, z) => [u, z - ground, len, eaveV];
    tri(W, A, B, C, n, n, [w(0, zBot), w(len, zBot), w(len, topB)]);
    if (Math.abs(topA - zBot) > 1e-4) tri(W, A, C, D, n, n, [w(0, zBot), w(len, topB), w(0, topA)]);
  };

  // a flat roof / slab over a (possibly concave) outline
  const slab = (outline, z) => {
    const { poly: o, tris } = triangulate(outline);
    for (const [i, j, k] of tris) tri(R, P(o[i][0], o[i][1], z), P(o[j][0], o[j][1], z), P(o[k][0], o[k][1], z), [0, 1, 0], [0, 1, 0]);
  };

  for (const b of buildings) {
    if (!b.poly || b.poly.length < 3) continue;
    const poly = ccw(cleanPolygon(b.poly));
    if (poly.length < 3) continue;
    if (Math.abs(signedArea(poly)) < 4) continue;
    let ground = Infinity;
    for (const [x, y] of poly) { const h = hAt(x, y); if (!Number.isFinite(h)) { ground = NaN; break; } ground = Math.min(ground, h); }
    if (!Number.isFinite(ground)) continue;
    const plan = roofPlan(b);
    const wallH = Math.max(2.6, b.heightM || 5);
    const zBot = ground - 0.6;              // sunk so walls meet a slope, never float
    const zE = ground + wallH;              // eaves
    const hc = hash(plan.rect.cx * 1.7, plan.rect.cy * 0.3);
    W.c = b.clubhouse && heroWall ? heroWall : (wallColors ? wallColors[Math.floor(hc * wallColors.length)] : [0.8, 0.78, 0.72]);
    R.c = b.clubhouse && heroRoof ? heroRoof : (roofColors ? roofColors[Math.floor(hash(plan.rect.cy, plan.rect.cx) * roofColors.length)] : [0.3, 0.3, 0.3]);
    const tanP = Math.tan((plan.pitchDeg * Math.PI) / 180);
    const outward = (i) => { const p = poly[i], q = poly[(i + 1) % poly.length]; const e = unit(q[0] - p[0], q[1] - p[1]); return [e[1], -e[0]]; };

    if (plan.type === 'canopy') {
      // an open roof on posts (carport, pavilion): just the slab
      const top = ground + Math.min(wallH, 3.4);
      slab(poly, top);
      count++;
      continue;
    }
    if (plan.type === 'flat') {
      const parapet = zE + 0.8;
      for (let i = 0; i < poly.length; i++) wallFace(poly[i], poly[(i + 1) % poly.length], zBot, parapet, parapet, ground, wallH, outward(i));
      slab(poly, zE + 0.05);
      count++;
      continue;
    }
    if (plan.type === 'gable' || plan.type === 'hip') {
      const { cx, cy, ux, uy, L, W: Wd } = plan.rect;
      const o = plan.overhang;
      const rise = (Wd / 2) * tanP;
      const zR = zE + rise;                 // ridge
      const drop = o * tanP;                // eaves hang below the wall top
      const at = (u, v, z) => P(cx + ux * u - uy * v, cy + uy * u + ux * v, z);
      const hu = L / 2, hv = Wd / 2;
      for (let i = 0; i < poly.length; i++) wallFace(poly[i], poly[(i + 1) % poly.length], zBot, zE, zE, ground, wallH, outward(i));
      if (plan.type === 'gable') {
        for (const s of [-1, 1]) {
          roofFace([at(-hu - o, s * (hv + o), zE - drop), at(hu + o, s * (hv + o), zE - drop), at(hu + o, 0, zR), at(-hu - o, 0, zR)]);
          // gable end wall up to the ridge, on the rectangle's end line
          const e0 = [cx + ux * s * hu - uy * -hv, cy + uy * s * hu + ux * -hv];
          const e1 = [cx + ux * s * hu - uy * hv, cy + uy * s * hu + ux * hv];
          const ridge = P(cx + ux * s * hu, cy + uy * s * hu, zR);
          const n = [ux * s, 0, -uy * s];
          const len = Wd;
          tri(W, P(e0[0], e0[1], zE), P(e1[0], e1[1], zE), ridge, n, n, [[0, wallH, len, wallH], [len, wallH, len, wallH], [len / 2, wallH + rise, len, wallH]]);
        }
      } else {
        const ridgeHalf = Math.max(0, hu - hv);
        for (const s of [-1, 1]) {
          // long sides: trapezoids up to the ridge; ends: triangles
          roofFace([at(-hu - o, s * (hv + o), zE - drop), at(hu + o, s * (hv + o), zE - drop), at(ridgeHalf, 0, zR), at(-ridgeHalf, 0, zR)]);
          roofFace([at(s * (hu + o), -(hv + o), zE - drop), at(s * (hu + o), hv + o, zE - drop), at(s * ridgeHalf, 0, zR)]);
        }
      }
      count++;
      continue;
    }
    // inset hip over the building's main mass (jogs under ~2 m smoothed away), at
    // the deepest inset that stays clean
    const mass = ccw(cleanPolygon(simplifyPolygon(poly, 2)));
    let inner = null, d = 0;
    for (const dd of [5, 4, 3, 2.2, 1.5]) { inner = insetPolygon(mass, dd); if (inner) { d = dd; break; } }
    if (!inner) {
      const parapet = zE + 0.8;
      for (let i = 0; i < poly.length; i++) wallFace(poly[i], poly[(i + 1) % poly.length], zBot, parapet, parapet, ground, wallH, outward(i));
      slab(poly, zE + 0.05);
      count++;
      continue;
    }
    for (let i = 0; i < poly.length; i++) wallFace(poly[i], poly[(i + 1) % poly.length], zBot, zE, zE, ground, wallH, outward(i));
    const o = plan.overhang, drop = o * tanP, zTop = zE + d * tanP;
    const eave = insetPolygon(mass, -o) || mass;
    for (let i = 0; i < mass.length; i++) {
      const j = (i + 1) % mass.length;
      roofFace([P(eave[i][0], eave[i][1], zE - drop), P(eave[j][0], eave[j][1], zE - drop), P(inner[j][0], inner[j][1], zTop), P(inner[i][0], inner[i][1], zTop)]);
    }
    slab(inner, zTop);   // the flat crown
    count++;
  }
  delete W.c; delete R.c;
  return { walls: W, roofs: R, count };
}
