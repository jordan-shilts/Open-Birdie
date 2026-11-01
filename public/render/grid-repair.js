// Render-side repair of a broken height-grid BORDER. Some cached courses carry an
// elevation grid whose outermost row/column was never filled from the DEM (left at
// a stale value metres away from its neighbours), which renders as a sheer wall
// along the course edge and reads as a green slab rim on the horizon. A border line
// is replaced by its inner neighbour only when it is clearly detached (median step
// > maxStepM) while the next two inner lines agree (median step < flatStepM), so
// real edge relief (a cliff, a dune face) is left alone. Pure; returns a NEW grid
// object (heights copied) only when something was repaired. Display-only: the
// interior (everything players can reach) is untouched.

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function repairGridEdges(grid, { maxStepM = 1.5, flatStepM = 0.35, passes = 2 } = {}) {
  if (!grid || !grid.heights || grid.nx < 4 || grid.ny < 4) return { grid, repaired: [] };
  const { nx, ny } = grid;
  const H = Array.from(grid.heights);
  const at = (i, j) => H[j * nx + i];
  const repaired = [];
  // line accessors: k = 0 is the border, 1 and 2 step inward
  const sides = {
    south: (k) => ({ get: (t) => at(t, k), set: (t, v) => { H[k * nx + t] = v; }, n: nx }),
    north: (k) => ({ get: (t) => at(t, ny - 1 - k), set: (t, v) => { H[(ny - 1 - k) * nx + t] = v; }, n: nx }),
    west: (k) => ({ get: (t) => at(k, t), set: (t, v) => { H[t * nx + k] = v; }, n: ny }),
    east: (k) => ({ get: (t) => at(nx - 1 - k, t), set: (t, v) => { H[t * nx + nx - 1 - k] = v; }, n: ny }),
  };
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const [name, line] of Object.entries(sides)) {
      const l0 = line(0), l1 = line(1), l2 = line(2);
      const d01 = [], d12 = [];
      for (let t = 0; t < l0.n; t++) {
        d01.push(Math.abs(l0.get(t) - l1.get(t)));
        d12.push(Math.abs(l1.get(t) - l2.get(t)));
      }
      if (median(d01) > maxStepM && median(d12) < flatStepM) {
        for (let t = 0; t < l0.n; t++) l0.set(t, l1.get(t));
        repaired.push(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!repaired.length) return { grid, repaired };
  return { grid: { ...grid, heights: H }, repaired };
}
