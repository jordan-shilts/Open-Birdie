// Pure browser height sampler — parity with lib/elevation.makeTerrain h().
// No three.js dependency. The renderer's placement sampler (hAt) and the physics
// terrain must agree, so this mirrors makeTerrain's raw-h + edgeBlendM blend
// exactly. HD patches take precedence over legacy green patches over the base.

const FEATHER_M = 4;

function gridSampler(grid) {
  const { minX, minY, cellM, nx, ny, heights } = grid;
  const maxX = minX + (nx - 1) * cellM;
  const maxY = minY + (ny - 1) * cellM;
  const cell = (x, y) => {
    let fx = (x - minX) / cellM; let fy = (y - minY) / cellM;
    fx = Math.min(Math.max(fx, 0), nx - 1.001);
    fy = Math.min(Math.max(fy, 0), ny - 1.001);
    const i = Math.floor(fx); const j = Math.floor(fy);
    return {
      dx: fx - i, dy: fy - j,
      h00: heights[j * nx + i], h10: heights[j * nx + i + 1],
      h01: heights[(j + 1) * nx + i], h11: heights[(j + 1) * nx + i + 1],
    };
  };
  return {
    minX, minY, maxX, maxY,
    contains: (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY,
    inset: (x, y) => Math.min(x - minX, maxX - x, y - minY, maxY - y),
    h(x, y) {
      const c = cell(x, y);
      return c.h00 * (1 - c.dx) * (1 - c.dy) + c.h10 * c.dx * (1 - c.dy) +
             c.h01 * (1 - c.dx) * c.dy + c.h11 * c.dx * c.dy;
    },
    grad(x, y) {
      const c = cell(x, y);
      return {
        dx: ((c.h10 - c.h00) * (1 - c.dy) + (c.h11 - c.h01) * c.dy) / cellM,
        dy: ((c.h01 - c.h00) * (1 - c.dx) + (c.h11 - c.h10) * c.dx) / cellM,
      };
    },
  };
}

export function makeTerrainSampler(base, patches = []) {
  const baseS = gridSampler(base);
  const entries = patches.map((p) => ({ s: gridSampler(p), edgeBlendM: p.edgeBlendM }));
  const lerp = (a, b, w) => a + (b - a) * w;
  const weightOf = (e, x, y) => {
    const blend = e.edgeBlendM ?? FEATHER_M;
    return blend <= 0 ? 1 : Math.min(1, e.s.inset(x, y) / blend);
  };
  const pick = (x, y) => {
    for (const e of entries) if (e.s.contains(x, y)) return { e, w: weightOf(e, x, y) };
    return null;
  };
  return {
    h(x, y) {
      const sel = pick(x, y);
      return sel ? lerp(baseS.h(x, y), sel.e.s.h(x, y), sel.w) : baseS.h(x, y);
    },
    grad(x, y) {
      const sel = pick(x, y);
      if (!sel) return baseS.grad(x, y);
      const b = baseS.grad(x, y); const g = sel.e.s.grad(x, y);
      return { dx: lerp(b.dx, g.dx, sel.w), dy: lerp(b.dy, g.dy, sel.w) };
    },
  };
}

// Vertex normals (three.js frame: x east, y up, z = -north) for a row-major height
// grid, taken from a gaussian-smoothed copy of the heights. Raw lidar carries ~0.1 m
// of grass and sensor noise per cell; on a 1-2 m grid that is several degrees of
// random slope, which the sun turns into blotchy light/dark patches across smooth
// mown turf. Smoothing only the shading keeps every vertex where the data put it.
export function smoothGridNormals(heights, nx, ny, cellM, sigmaM = 2) {
  const sigma = sigmaM / cellM;
  let h = heights;
  if (sigma > 0.25) {
    const rad = Math.max(1, Math.ceil(sigma * 2.5));
    const kernel = [];
    let sum = 0;
    for (let k = -rad; k <= rad; k++) { const w = Math.exp(-(k * k) / (2 * sigma * sigma)); kernel.push(w); sum += w; }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
    const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let k = -rad; k <= rad; k++) v += heights[j * nx + Math.min(nx - 1, Math.max(0, i + k))] * kernel[k + rad];
        tmp[j * nx + i] = v;
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let k = -rad; k <= rad; k++) v += tmp[Math.min(ny - 1, Math.max(0, j + k)) * nx + i] * kernel[k + rad];
        out[j * nx + i] = v;
      }
    }
    h = out;
  }
  const normals = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
      const dx = (h[j * nx + i1] - h[j * nx + i0]) / (Math.max(1, i1 - i0) * cellM);
      const dy = (h[j1 * nx + i] - h[j0 * nx + i]) / (Math.max(1, j1 - j0) * cellM); // +north
      // surface y = h(x, z) with z = -north, so dh/dz = -dy: normal (-dx, 1, dy)
      const len = Math.hypot(dx, 1, dy);
      const k = (j * nx + i) * 3;
      normals[k] = -dx / len; normals[k + 1] = 1 / len; normals[k + 2] = dy / len;
    }
  }
  return normals;
}
