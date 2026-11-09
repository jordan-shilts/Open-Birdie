// Pure geometry helpers for "surface patches" — rendering a golf surface polygon
// (bunker/green/tee) as its own mesh draped on the terrain height field, so its
// boundary is a real geometric edge (crisp at any zoom) instead of a blurry
// low-res splat paint. No three / no DOM here, so it unit-tests under node;
// scene.js triangulates (THREE.ShapeUtils) and assembles the BufferGeometry.

// Split polygon edges longer than maxLen so the draped boundary follows terrain
// relief. Drops a closing-duplicate vertex (OSM rings often repeat point 0).
// Returns an open ring of [x, y] in local meters.
export function densifyRing(poly, maxLen) {
  const ring = poly.slice();
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) ring.pop();
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    out.push([a[0], a[1]]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const segs = Math.max(1, Math.floor(len / maxLen));
    for (let s = 1; s < segs; s++) {
      const t = s / segs;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// Drape a ring onto sampler(x,y)->height, emitting positions in three coords
// (x, h+offset, -y) and UVs normalized over `bounds` (same UV space as the base
// terrain, so the tiled PBR detail lines up). Returns {pos:Float32Array, uv:Float32Array}.
export function drapeRing(ring, sampler, bounds, offset = 0) {
  const n = ring.length;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const extX = bounds.maxX - bounds.minX, extY = bounds.maxY - bounds.minY;
  for (let i = 0; i < n; i++) {
    const x = ring[i][0], y = ring[i][1];
    pos[i * 3] = x;
    pos[i * 3 + 1] = sampler(x, y) + offset;
    pos[i * 3 + 2] = -y;
    uv[i * 2] = (x - bounds.minX) / extX;
    uv[i * 2 + 1] = (y - bounds.minY) / extY;
  }
  return { pos, uv };
}

// Refine a triangulated polygon until it follows the ground. A patch triangulated from
// its ring alone only touches the terrain along its edge: the triangles inside span
// straight across, so a hollow under them is lidded over (a real bunker's bowl drew
// flat) and a rise between them pokes through as a patch of the ground's own material.
//
// points: [[x, y], ...] (the ring, densified); tris: [[a, b, c], ...] indices into it;
// sampler(x, y) -> ground height. An edge is cut in half where it is longer than
// maxEdge, or longer than minEdge while the ground under it leaves the straight line
// between its ends by more than tol (tested at its quarter points); a triangle whose
// middle leaves its plane by more than tol has its longest edge cut. Every triangle on
// a cut edge is re-cut around the same new point, so no cracks open between neighbours.
// Stops when nothing is cut, after maxPasses, or at maxTris (the cap of last resort: a
// huge waste area keeps the detail it reached).
// Returns { points, tris } with the new points appended to the ring's; tris keep the
// winding they came with.
export function conformTriangles(points, tris, sampler, {
  maxEdge = 6, minEdge = 1.5, tol = 0.03, maxPasses = 8, maxTris = 6000,
} = {}) {
  const pts = points.map((p) => [p[0], p[1]]);
  const hs = pts.map((p) => sampler(p[0], p[1]));
  let cur = tris.map((t) => [t[0], t[1], t[2]]);
  const key = (a, b) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  const len = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
  // does the ground under the edge a-b leave the straight line between its ends?
  const bends = (a, b) => {
    for (const t of [0.5, 0.25, 0.75]) {
      const x = pts[a][0] + (pts[b][0] - pts[a][0]) * t, y = pts[a][1] + (pts[b][1] - pts[a][1]) * t;
      if (Math.abs(sampler(x, y) - (hs[a] + (hs[b] - hs[a]) * t)) > tol) return true;
    }
    return false;
  };
  for (let pass = 0; pass < maxPasses && cur.length < maxTris; pass++) {
    const verdict = new Map();   // edge key -> cut it?
    const wants = (a, b) => {
      const k = key(a, b);
      let v = verdict.get(k);
      if (v === undefined) {
        const L = len(a, b);
        v = L > maxEdge || (L > minEdge && bends(a, b));
        verdict.set(k, v);
      }
      return v;
    };
    let any = false;
    for (const [a, b, c] of cur) {
      const cut = wants(a, b) | wants(b, c) | wants(c, a);
      if (cut) { any = true; continue; }
      // flat along all three edges, yet the ground may rise or fall in the middle
      const lab = len(a, b), lbc = len(b, c), lca = len(c, a);
      const longest = Math.max(lab, lbc, lca);
      if (longest <= minEdge) continue;
      const mx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3, my = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
      if (Math.abs(sampler(mx, my) - (hs[a] + hs[b] + hs[c]) / 3) > tol) {
        verdict.set(longest === lab ? key(a, b) : longest === lbc ? key(b, c) : key(c, a), true);
        any = true;
      }
    }
    if (!any) break;
    const mids = new Map();
    const mid = (a, b) => {
      const k = key(a, b);
      if (!verdict.get(k)) return -1;
      let m = mids.get(k);
      if (m === undefined) {
        m = pts.length;
        const x = (pts[a][0] + pts[b][0]) / 2, y = (pts[a][1] + pts[b][1]) / 2;
        pts.push([x, y]);
        hs.push(sampler(x, y));
        mids.set(k, m);
      }
      return m;
    };
    const next = [];
    for (const [a, b, c] of cur) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      const n = (ab >= 0) + (bc >= 0) + (ca >= 0);
      if (n === 0) next.push([a, b, c]);
      else if (n === 3) next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      else if (n === 1) {
        if (ab >= 0) next.push([a, ab, c], [ab, b, c]);
        else if (bc >= 0) next.push([a, b, bc], [a, bc, c]);
        else next.push([a, b, ca], [ca, b, c]);
      } else if (ab < 0) next.push([a, b, bc], [a, bc, ca], [ca, bc, c]);      // bc + ca cut
      else if (bc < 0) next.push([a, ab, ca], [ab, b, c], [ab, c, ca]);        // ab + ca cut
      else next.push([a, ab, c], [ab, b, bc], [ab, bc, c]);                    // ab + bc cut
    }
    cur = next;
  }
  return { points: pts, tris: cur };
}

// The ground's shading normal at (x, y) in three coordinates (x east, y up, z = -north),
// from heights `span` metres either side: wide enough that lidar noise does not facet a
// draped patch (the terrain shades from smoothed heights for the same reason).
export function groundNormal(sampler, x, y, span = 1.5) {
  const dx = (sampler(x + span, y) - sampler(x - span, y)) / (2 * span);
  const dy = (sampler(x, y + span) - sampler(x, y - span)) / (2 * span);
  const l = Math.hypot(dx, 1, dy);
  return [-dx / l, 1 / l, dy / l];
}
