import { RENDER_CONFIG } from './config.js';

const BASE = '/assets/';
export const ASSETS = {
  hdri: () => `${BASE}hdri/${RENDER_CONFIG.hdriFile}`,
  trees: {
    foliageDiff: `${BASE}trees/foliage_diff.jpg`,
    foliageAlpha: `${BASE}trees/foliage_alpha.jpg`,
    bark: `${BASE}trees/bark_diff.jpg`,
    broadleafDiff: `${BASE}trees/broadleaf_diff.jpg`,
    broadleafAlpha: `${BASE}trees/broadleaf_alpha.jpg`,
    broadleafBark: `${BASE}trees/broadleaf_bark.jpg`,
    // 3D trees (trees.js / leaf-atlas.js)
    leafDiff: `${BASE}trees/leaves_diff.jpg`,
    leafAlpha: `${BASE}trees/leaves_alpha.jpg`,
    pineTwigDiff: `${BASE}trees/pine_twig_diff.jpg`,
    pineTwigAlpha: `${BASE}trees/pine_twig_alpha.jpg`,
    oakBark: `${BASE}trees/oak_bark.jpg`,
    pineBark: `${BASE}trees/pine_bark.jpg`,
  },
  turf: {
    color: `${BASE}turf/grass_color.jpg`,
    normal: `${BASE}turf/grass_normal.jpg`,
    rough: `${BASE}turf/grass_rough.jpg`,
    sand: `${BASE}turf/sand_color.jpg`,
    sandNormal: `${BASE}turf/sand_normal.jpg`,
    sandRough: `${BASE}turf/sand_rough.jpg`,
  },
};
