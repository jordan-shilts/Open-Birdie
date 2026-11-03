// Divots: the sand-and-seed filled scars every played tee box and fairway carries.
// One chance per 0.6 m cell (far better on tees; on fairways they bunch where shots
// land), decided by a hash of the cell and by the surface at the cell's centre, so the
// turf shader (which paints the scar) and the grass field (which grows no blades in
// it) agree on every divot. The hash is plain arithmetic, no sin(): a vertex and a
// fragment shader must get the same answer. A divot sits inside its cell, so no
// neighbour cells need checking.
export const DIVOT_CELL_M = 0.6;
export const DIVOT_CHANCE = { tee: 0.3, fairway: 0.05 };

const f = (v) => v.toFixed(6);

// divotCell(w, ext, mownMask, auxMask, out centre, out rot, out radii, out look): w is
// metres from the turf bounds' min corner, ext the bounds' size (w / ext is the masks'
// UV). False when w's cell has no divot. look: 0..1 per divot (fresh sand .. healing).
// divotE(w, ...): elliptical distance from the divot's centre, < 1 inside; its local
// x (heel -1 .. torn front +1) comes from divotAlong.
export const DIVOT_GLSL = /* glsl */`
  float dvHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  // smooth 0..1 field over ~7 m: where on a fairway the shots come down
  float dvCluster(vec2 w) {
    vec2 p = w * ${f(1 / 7)}, i = floor(p), t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    float a = dvHash(i + 101.0), b = dvHash(i + vec2(102.0, 101.0));
    float c = dvHash(i + vec2(101.0, 102.0)), d = dvHash(i + 102.0);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  }
  bool divotCell(vec2 w, vec2 ext, sampler2D mownMask, sampler2D auxMask, out vec2 c, out mat2 rot, out vec2 r, out float look) {
    vec2 cell = floor(w * ${f(1 / DIVOT_CELL_M)});
    float h1 = dvHash(cell);
    c = vec2(0.0); rot = mat2(1.0); r = vec2(1.0); look = 0.0;
    if (h1 >= ${f(Math.max(DIVOT_CHANCE.tee, DIVOT_CHANCE.fairway * 1.8))}) return false;
    float h2 = dvHash(cell + 17.0), h3 = dvHash(cell + 41.0), h4 = dvHash(cell + 73.0);
    c = (cell + 0.25 + 0.5 * vec2(h2, h3)) * ${f(DIVOT_CELL_M)};
    // the surface where the divot sits: mown and not a green; a tee takes far more
    vec4 mw = textureLod(mownMask, c / ext, 0.0);
    float tee = step(0.5, textureLod(auxMask, c / ext, 0.0).r);
    float fair = ${f(DIVOT_CHANCE.fairway)} * (0.2 + 1.6 * dvCluster(c));
    float chance = step(0.5, mw.r) * (1.0 - step(0.5, mw.g)) * mix(fair, ${f(DIVOT_CHANCE.tee)}, tee);
    if (h1 >= chance) return false;
    float a = h4 * 6.2831853;
    rot = mat2(cos(a), -sin(a), sin(a), cos(a));
    r = vec2(0.065, 0.03) * (0.8 + 0.5 * fract(h2 * 7.13 + h3 * 3.71));   // ~10-17 cm long
    look = fract(h1 * 13.7 + h4 * 5.3);
    return true;
  }
  float divotE(vec2 w, vec2 c, mat2 rot, vec2 r) { return length((rot * (w - c)) / r); }
  float divotAlong(vec2 w, vec2 c, mat2 rot, vec2 r) { return (rot * (w - c)).x / r.x; }`;
