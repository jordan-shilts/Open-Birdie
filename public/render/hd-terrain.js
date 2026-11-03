// High-resolution terrain mesh + a coarse mesh with the HD interior removed.
//
// The HD rectangle was compiler-snapped to coarse cell lines, so whole coarse
// cells inside it are dropped and the HD mesh fills the cutout — a shared
// boundary with ZERO positive-area overlap (a plain overlay is forbidden: lower
// HD relief could be occluded by the coarse surface). Vertex layout matches the
// runtime base mesh: pos = (minX+i·cellM, height, -(minY+j·cellM)) (THREE z is
// -localY), uv = (i/(nx-1), j/(ny-1)).

import * as THREE from 'three';

function gridGeometry(grid, skip, uvBounds) {
  const { minX, minY, cellM, nx, ny, heights } = grid;
  // UVs are course-relative when uvBounds is given (so a course-wide splat/mask
  // aligns over an HD sub-mesh); otherwise self-relative (i/(nx-1)).
  const ub = uvBounds || { minX, minY, maxX: minX + (nx - 1) * cellM, maxY: minY + (ny - 1) * cellM };
  const uExtX = ub.maxX - ub.minX; const uExtY = ub.maxY - ub.minY;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = j * nx + i;
      pos[k * 3] = minX + i * cellM;
      pos[k * 3 + 1] = heights[k];
      pos[k * 3 + 2] = -(minY + j * cellM);
      uv[k * 2] = (minX + i * cellM - ub.minX) / uExtX;
      uv[k * 2 + 1] = (minY + j * cellM - ub.minY) / uExtY;
    }
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      if (skip && skip(i, j)) continue;
      const a = j * nx + i; const c = a + nx;
      idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

// True when grid cell (i,j)'s WHOLE footprint lies inside any of `rects`. HD rects
// are snapped to coarse cell lines, so a cell is fully in or fully out — no partial
// cells. Shared by the coarse cutout (drop cells under any HD patch) and the HD
// skip-overlap clip (drop cells already covered by an earlier patch).
export function cellInAnyRect(grid, i, j, rects) {
  if (!rects || !rects.length) return false;
  const { minX, minY, cellM } = grid;
  const eps = cellM * 1e-6;
  const x0 = minX + i * cellM; const x1 = minX + (i + 1) * cellM;
  const y0 = minY + j * cellM; const y1 = minY + (j + 1) * cellM;
  for (const r of rects) {
    if (x0 >= r.minX - eps && x1 <= r.maxX + eps && y0 >= r.minY - eps && y1 <= r.maxY + eps) return true;
  }
  return false;
}

// One HD patch mesh. `skipBounds` (rects of EARLIER patches) drops cells already
// covered upstream, so overlapping padded hole rects don't double-cover / z-fight;
// the kept patch matches the sampler's first-match order (visuals == physics).
export function buildHdTerrain({ grid, material, uvBounds, skipBounds }) {
  const skip = (skipBounds && skipBounds.length) ? (i, j) => cellInAnyRect(grid, i, j, skipBounds) : null;
  const mesh = new THREE.Mesh(gridGeometry(grid, skip, uvBounds), material);
  mesh.receiveShadow = true;
  return mesh;
}

export function buildCoarseTerrain({ grid, cutouts, material }) {
  // Remove a coarse cell if its whole footprint lies inside ANY HD patch rect, so
  // the HD meshes fill the union of cutouts with zero positive-area overlap.
  const inCutout = (cutouts && cutouts.length) ? (i, j) => cellInAnyRect(grid, i, j, cutouts) : null;
  const mesh = new THREE.Mesh(gridGeometry(grid, inCutout), material);
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- detail by distance
// The course draws as tiles (coarse grid) and patches (HD holes), each with one mesh
// per level of detail — a level steps over `step` grid cells per cell — and
// updateTerrainLod() shows the level each one's distance from the camera calls for.
// Every level hangs a skirt under the edges of what it draws, so neighbours at another
// level, or from another source (an HD patch against the coarse grid), meet without the
// see-through cracks a T-junction leaves (the dotted line along HD tile edges).
// Full detail everywhere was ~3.7 M triangles a pass on an HD course; tiles behind the
// camera are also frustum-culled now, where one course-wide mesh never could be.

const SKIRT_M = 1.5;   // skirt depth below an edge: more than any HD/coarse mismatch

// True when the span of grid cells [i0..i1] x [j0..j1] lies wholly inside any rect.
function spanInAnyRect(grid, i0, j0, i1, j1, rects) {
  if (!rects || !rects.length) return false;
  const { minX, minY, cellM } = grid;
  const eps = cellM * 1e-6;
  const x0 = minX + i0 * cellM, x1 = minX + i1 * cellM, y0 = minY + j0 * cellM, y1 = minY + j1 * cellM;
  for (const r of rects) {
    if (x0 >= r.minX - eps && x1 <= r.maxX + eps && y0 >= r.minY - eps && y1 <= r.maxY + eps) return true;
  }
  return false;
}

// One level of one tile: cells of `step` grid cells over [i0..i1] x [j0..j1] (the far
// edge always included), minus cells `skip` rejects, plus skirts. `normals` is the
// grid's own per-vertex normal field, so every level of a tile shades the same.
export function lodGeometry(grid, { i0, j0, i1, j1, step, skip = null, uvBounds = null, normals }) {
  const { minX, minY, cellM, nx, ny, heights } = grid;
  const cols = []; for (let i = i0; i < i1; i += step) cols.push(i); cols.push(i1);
  const rows = []; for (let j = j0; j < j1; j += step) rows.push(j); rows.push(j1);
  const ub = uvBounds || { minX, minY, maxX: minX + (nx - 1) * cellM, maxY: minY + (ny - 1) * cellM };
  const uExtX = ub.maxX - ub.minX, uExtY = ub.maxY - ub.minY;
  const W = cols.length, H = rows.length;
  const pos = [], uv = [], nor = [], idx = [];
  const vert = (i, j, drop) => {
    const k = j * nx + i, x = minX + i * cellM, y = minY + j * cellM;
    pos.push(x, heights[k] - drop, -y);
    // a skirt's texture coordinates run down it as far as across it, so the normal
    // map's derivative frame is well-formed there (constant UVs down a skirt drew a
    // dotted dark line wherever a sliver of skirt showed through a seam)
    uv.push((x + drop - ub.minX) / uExtX, (y - drop - ub.minY) / uExtY);
    nor.push(normals[k * 3], normals[k * 3 + 1], normals[k * 3 + 2]);
    return pos.length / 3 - 1;
  };
  for (const j of rows) for (const i of cols) vert(i, j, 0);
  const kept = new Uint8Array((W - 1) * (H - 1));
  for (let b = 0; b < H - 1; b++) {
    for (let a = 0; a < W - 1; a++) {
      if (skip && skip(cols[a], rows[b], cols[a + 1], rows[b + 1])) continue;
      kept[b * (W - 1) + a] = 1;
      const v00 = b * W + a, v10 = v00 + 1, v01 = v00 + W, v11 = v01 + 1;
      idx.push(v00, v10, v01, v10, v11, v01);
    }
  }
  if (!idx.length) return null;
  const isKept = (a, b) => a >= 0 && b >= 0 && a < W - 1 && b < H - 1 && kept[b * (W - 1) + a] === 1;
  // a skirt quad under the edge va-vb, wound both ways so it shows from either side
  const skirt = (va, vb) => {
    const da = vert(cols[va % W], rows[Math.floor(va / W)], SKIRT_M);
    const db = vert(cols[vb % W], rows[Math.floor(vb / W)], SKIRT_M);
    idx.push(va, vb, db, va, db, da, va, db, vb, va, da, db);
  };
  for (let b = 0; b < H - 1; b++) {
    for (let a = 0; a < W - 1; a++) {
      if (!isKept(a, b)) continue;
      const v00 = b * W + a, v10 = v00 + 1, v01 = v00 + W, v11 = v01 + 1;
      if (!isKept(a, b - 1)) skirt(v00, v10);
      if (!isKept(a, b + 1)) skirt(v01, v11);
      if (!isKept(a - 1, b)) skirt(v00, v01);
      if (!isKept(a + 1, b)) skirt(v10, v11);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// Levels for one tile/patch -> a group whose children are its meshes (finest first);
// `far` lists the distance (m) at which each coarser level takes over.
function lodEntry(grid, span, steps, far, { skip, uvBounds, normals, material }) {
  const group = new THREE.Group();
  const meshes = [];
  for (const step of steps) {
    const geom = lodGeometry(grid, { ...span, step, skip, uvBounds, normals });
    if (!geom) continue;
    const mesh = new THREE.Mesh(geom, material);
    mesh.receiveShadow = true;
    mesh.visible = meshes.length === 0;
    group.add(mesh);
    meshes.push(mesh);
  }
  if (!meshes.length) return null;
  const { minX, minY, cellM } = grid;
  group.userData.lod = {
    meshes, far: far.slice(0, meshes.length - 1), level: 0,
    minX: minX + span.i0 * cellM, maxX: minX + span.i1 * cellM,
    minY: minY + span.j0 * cellM, maxY: minY + span.j1 * cellM,
  };
  return group;
}

// The coarse grid as tiles of `tile` cells. Tiles touching an HD cutout keep full
// detail (their cutout edges must stay exact); the rest step down with distance.
export function buildCoarseTerrainLod({ grid, cutouts = [], material, normals, tile = 128 }) {
  const root = new THREE.Group();
  root.name = 'terrainLod';
  const { nx, ny, minX, minY, cellM } = grid;
  const inCutout = cutouts.length ? (i0, j0, i1, j1) => spanInAnyRect(grid, i0, j0, i1, j1, cutouts) : null;
  for (let j0 = 0; j0 < ny - 1; j0 += tile) {
    for (let i0 = 0; i0 < nx - 1; i0 += tile) {
      const span = { i0, j0, i1: Math.min(i0 + tile, nx - 1), j1: Math.min(j0 + tile, ny - 1) };
      const x0 = minX + span.i0 * cellM, x1 = minX + span.i1 * cellM, y0 = minY + span.j0 * cellM, y1 = minY + span.j1 * cellM;
      const touchesHd = cutouts.some((r) => r.minX < x1 && r.maxX > x0 && r.minY < y1 && r.maxY > y0);
      const entry = lodEntry(grid, span, touchesHd ? [1] : [1, 2, 4], [320, 850],
        { skip: inCutout, normals, material });
      if (entry) root.add(entry);
    }
  }
  return root;
}

// One HD patch at full (1 m) and half detail. Its rect sits on the coarse grid's 2 m
// lattice, so 2 m cells stay exact against the earlier patches' rects (skipBounds).
export function buildHdTerrainLod({ grid, material, uvBounds, skipBounds = [] }) {
  const { nx, ny, heights, cellM } = grid;
  const normals = smoothGridNormalsRaw(heights, nx, ny, cellM);
  const skip = skipBounds.length ? (i0, j0, i1, j1) => spanInAnyRect(grid, i0, j0, i1, j1, skipBounds) : null;
  const root = new THREE.Group();
  root.name = 'hdTerrainLod';
  const entry = lodEntry(grid, { i0: 0, j0: 0, i1: nx - 1, j1: ny - 1 }, [1, 2], [240], { skip, uvBounds, normals, material });
  if (entry) root.add(entry);
  return root;
}

// Central-difference normals straight off the heights (as computeVertexNormals gives a
// regular grid), in three space: surface y = h(x, z) with z = -north.
function smoothGridNormalsRaw(heights, nx, ny, cellM) {
  const out = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
      const dx = (heights[j * nx + i1] - heights[j * nx + i0]) / ((i1 - i0) * cellM);
      const dy = (heights[j1 * nx + i] - heights[j0 * nx + i]) / ((j1 - j0) * cellM);
      const len = Math.hypot(dx, 1, dy), k = (j * nx + i) * 3;
      out[k] = -dx / len; out[k + 1] = 1 / len; out[k + 2] = dy / len;
    }
  }
  return out;
}

// Show each tile's level for this camera. Distance is 3D to the tile's footprint (a
// camera high above a tile is far from its detail too); a 12% band of hysteresis keeps
// a tile at the ring from flickering between two levels.
export function updateTerrainLod(root, camera) {
  if (!root) return;
  const cx = camera.position.x, cy = -camera.position.z, cz = camera.position.y;
  root.traverse((o) => {
    const L = o.userData && o.userData.lod;
    if (!L) return;
    const dx = Math.max(L.minX - cx, 0, cx - L.maxX), dy = Math.max(L.minY - cy, 0, cy - L.maxY);
    const d = Math.hypot(dx, dy, Math.max(0, cz - 60) * 0.8);
    let level = 0;
    while (level < L.far.length && d > L.far[level] * (level < L.level ? 0.88 : 1)) level++;
    if (level !== L.level) {
      L.meshes[L.level].visible = false;
      L.meshes[level].visible = true;
      L.level = level;
    }
  });
}
