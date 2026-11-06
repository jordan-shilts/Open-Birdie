// Trees in front of the shot are drawn see-through (trees.js): which ones. Pure (no
// three, no DOM) so the zone is unit-tested (test/tree-fade.test.mjs).
//
// In front means ahead of the camera across the middle of the view, within
// FADE_NEAR_M (a cone a crown wide that widens with distance: the ball and the shot
// are in the middle of the frame), or within FADE_HUG_M of the camera anywhere it
// looks. Worked out per tree from its foot in view space, so a tree goes see-through
// whole. A tree in the zone is drawn at FADE_SHOWN opacity — a faint ghost, alpha
// blended — and still casts its shadow and still stops a ball.
export const FADE_NEAR_M = 45;
export const FADE_HUG_M = 9;
export const FADE_SHOWN = 0.07;   // opacity of a see-through tree: barely there
export const FADE_AT = 0.35;      // this far into the zone (0-1) a tree is drawn see-through

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// vx, vz: the tree's foot in view space (camera at the origin looking down -z);
// treeH: its height (m). Returns 0 (clear of the shot) .. 1 (squarely in front).
export function treeFade(vx, vz, treeH, near = FADE_NEAR_M, hug = FADE_HUG_M) {
  const depth = -vz;
  const halfW = 0.3 * treeH + 1 + 0.06 * Math.max(depth, 0);
  const cone = (1 - smooth(halfW, halfW + 3, Math.abs(vx))) * (1 - smooth(near * 0.75, near, depth)) * (depth >= -1 ? 1 : 0);
  const close = (1 - smooth(hug * 0.7, hug, Math.hypot(vx, vz))) * (depth >= -halfW ? 1 : 0);
  return Math.max(cone, close);
}
