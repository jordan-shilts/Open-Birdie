// Pond water lines and beds from hydro-flattened lidar. Pure (no three, no DOM) so
// it is unit-tested (test/water-shore.test.mjs).
//
// USGS 3DEP elevation is hydro-flattened: a pond's interior is one flat height at
// its water line. The renderer used to take the LOWEST outline vertex as the water
// level and sit the plane a few centimetres under it — under the flat interior — so
// the turf drew over most of every pond and its reflection. Now:
//   - the level is the median height inside the outline (the flattened water line);
//   - the render terrain is carved into a shallow bed under each pond, deepening
//     away from the shore, so there is water to see and the shallows can clear;
//   - the water plane is grown a couple of metres past the OSM outline, so the real
//     bank, where it rises out of the water, draws the shoreline (OSM outlines are
//     traced by hand and wander a metre or two either side of it).

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToEdges(x, y, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], dx = poly[i][0] - ax, dy = poly[i][1] - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    d = Math.min(d, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return d;
}

function bbox(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, minY, maxX, maxY };
}

// The water line: median ground height inside the outline (sampled every stepM),
// or the lowest outline height for a pond too small to sample.
export function pondLevel(poly, hAt, stepM = 2) {
  const b = bbox(poly);
  const hs = [];
  for (let y = b.minY + stepM / 2; y < b.maxY; y += stepM) {
    for (let x = b.minX + stepM / 2; x < b.maxX; x += stepM) if (pointInPoly(x, y, poly)) hs.push(hAt(x, y));
  }
  if (hs.length < 3) return Math.min(...poly.map(([x, y]) => hAt(x, y)));
  hs.sort((a, c) => a - c);
  return hs[Math.floor(hs.length / 2)];
}

// Grow a simple polygon outward by d metres (vertex-normal offset, miter capped at
// 2d so a sharp inward corner can't spike).
export function growPolygon(poly, d) {
  const n = poly.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  const s = area > 0 ? 1 : -1;   // CCW: an edge's outward normal is (dy, -dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n], c = poly[i], q = poly[(i + 1) % n];
    const e1 = norm2(c[0] - p[0], c[1] - p[1]), e2 = norm2(q[0] - c[0], q[1] - c[1]);
    const n1 = [e1[1] * s, -e1[0] * s], n2 = [e2[1] * s, -e2[0] * s];
    let m = norm2(n1[0] + n2[0], n1[1] + n2[1]);
    const cos = m[0] * n1[0] + m[1] * n1[1];
    const k = Math.min(2, 1 / Math.max(0.5, cos));
    if (!Number.isFinite(m[0])) m = n1;
    out.push([c[0] + m[0] * d * k, c[1] + m[1] * d * k]);
  }
  return out;
}
function norm2(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

// Ponds for a course: [{ poly, grown, level, minX, minY, maxX, maxY }].
export function coursePonds(surfaces, hAt, { growM = 2 } = {}) {
  const ponds = [];
  for (const s of surfaces || []) {
    if (s.kind !== 'water' || !s.poly || s.poly.length < 3) continue;
    ponds.push({ poly: s.poly, grown: growPolygon(s.poly, growM), level: pondLevel(s.poly, hAt), ...bbox(s.poly) });
  }
  return ponds;
}

// A copy of a row-major height grid with a bed carved under every pond: lip m
// below the water line at the outline, deepening `slope` m per metre from it, to
// maxDepth. The grid's row j lies at y = minY + j * cellM, column i at x = minX + i * cellM.
export function carveBeds(heights, { nx, ny, minX, minY, cellM }, ponds, { lip = 0.12, slope = 0.3, maxDepth = 1.8 } = {}) {
  const out = Float32Array.from(heights);
  for (const p of ponds) {
    const i0 = Math.max(0, Math.floor((p.minX - minX) / cellM)), i1 = Math.min(nx - 1, Math.ceil((p.maxX - minX) / cellM));
    const j0 = Math.max(0, Math.floor((p.minY - minY) / cellM)), j1 = Math.min(ny - 1, Math.ceil((p.maxY - minY) / cellM));
    for (let j = j0; j <= j1; j++) {
      const y = minY + j * cellM;
      for (let i = i0; i <= i1; i++) {
        const x = minX + i * cellM;
        if (!pointInPoly(x, y, p.poly)) continue;
        const depth = Math.min(maxDepth, lip + distToEdges(x, y, p.poly) * slope);
        const k = j * nx + i;
        out[k] = Math.min(out[k], p.level - depth);
      }
    }
  }
  return out;
}
