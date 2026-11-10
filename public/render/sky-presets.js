// Time of day: one setting picks the sky photo (HDRI) and the light that goes with
// it. Pure (no three, no DOM) so the presets and the setting cycle are unit-tested
// (test/sky-presets.test.mjs).
//
// The sun's direction always comes from the sky photo itself (its brightest texel,
// hdri-analyze.js), so shadows fall away from the bright part of the sky. Midday
// keeps a lowered sun (24 deg since the 2026-11 visual pass: at 36 the light came in
// flat and the 1 m lidar relief, bunker faces and green slopes all but vanished) and
// ships with the app; the others are CC0 Poly Haven skies the game server fetches
// the first time they're picked and keeps (lib/sky-cache.js), so the install stays
// small and a sky picked once works offline. Midday is the fallback when one can't
// be fetched.
//
// Weather is a sky too. Under cloud or in fog the sky itself is the light (`overcast`):
// the sun is a faint hint of direction with barely a shadow, the fill carries the scene
// and colours sit flat and even, the way a links looks on a grey day. Sea fog is the
// same light with the air closed in: a few hundred metres of ground, then nothing
// (Pebble Beach's marine layer, the haar at St Andrews). Light levels were set from the
// sky photos' own radiance (a level, fully diffuse surface under each sky) so a grey day
// is a little dimmer than a sunny one, not a different exposure.

// Served by the game server, which fetches each Poly Haven sky once and keeps it
// (lib/sky-cache.js), so a sky picked once also works without the internet.
const POLY_HAVEN_4K = (id) => `/sky/${id}_4k.hdr`;

export const SKY_PRESETS = Object.freeze({
  morning: Object.freeze({
    label: 'Morning',
    hdri: POLY_HAVEN_4K('rustig_koppie_puresky'),   // clear, crisp, low-ish sun
    sunAltitudeDeg: null,
    sunColor: '#ffe9cf',
    sunIntensity: 4.6,
    environmentIntensity: 0.42,
    exposure: 0.72,
    fogDensity: 0.00052,   // a little morning haze in the low ground
  }),
  midday: Object.freeze({
    label: 'Midday',
    hdri: null,            // the bundled sky (RENDER_CONFIG.hdriFile)
    sunAltitudeDeg: 24,
    sunColor: '#ffe9cc',
    sunIntensity: 5.2,
    environmentIntensity: 0.4,   // sky fill: shade sides of mounds and swales read (0.32 crushed tree shade to near-black)
    exposure: 0.8,
    fogDensity: 0.00042,
  }),
  golden: Object.freeze({
    label: 'Golden hour',
    hdri: POLY_HAVEN_4K('kloppenheim_06_puresky'),  // low sun, warm cloud
    sunAltitudeDeg: null,
    sunColor: '#ffb877',
    sunIntensity: 3.8,
    environmentIntensity: 0.5,
    exposure: 0.86,
    fogDensity: 0.00045,
  }),
  overcast: Object.freeze({
    label: 'Overcast',
    hdri: POLY_HAVEN_4K('kloofendal_overcast_puresky'),   // an even grey ceiling
    overcast: true,
    sunAltitudeDeg: 40,
    sunColor: '#f2f1ec',
    sunIntensity: 0.6,          // a hint of where the sun is: the softest of shadows
    environmentIntensity: 0.68, // the cloud deck is the light (0.5 left the turf a stop under a sunny day's)
    exposure: 0.8,
    fogDensity: 0.0009,         // damp air: the far tree line greys out
  }),
  fog: Object.freeze({
    label: 'Sea fog',
    hdri: POLY_HAVEN_4K('kloofendal_misty_morning_puresky'),   // a bright, featureless white sky
    overcast: true,
    sunAltitudeDeg: 40,
    sunColor: '#f4f3ef',
    sunIntensity: 0.25,
    environmentIntensity: 0.7,
    exposure: 0.82,
    fogDensity: 0.0042,         // about a tenth gone at 50 m, a quarter at 100 m, nearly all by 300 m
  }),
});

// GRASS STANDS UP. The lighting model lights the ground as a level sheet, which a low sun
// barely grazes: at 10 degrees a level surface gets a sixth of the sun, and a fairway at
// golden hour drew near black once it stopped mirroring the sun (turf.js). A real one
// glows, because the sun is not lighting a sheet but the sides of the blades standing on
// it. Light half the turf as level ground and half as upright blades facing every way
// (which catch (2/pi) cos(altitude) of the sun), and this is how much brighter than the
// sheet that is: about 2.3x at 10 degrees. Faded out by 24 degrees, midday's sun, where
// the sheet is already close and the look is tuned as it stands. sunY: the sun
// direction's upward part (the sine of its altitude). Returns the extra, 0 = none.
export function lowSunLift(sunY) {
  if (!Number.isFinite(sunY)) return 0;
  const y = Math.min(1, Math.max(0.05, sunY));
  const blades = 0.5 * y + 0.5 * (2 / Math.PI) * Math.sqrt(1 - y * y);
  const altDeg = Math.asin(y) * 180 / Math.PI;
  const t = Math.min(1, Math.max(0, (altDeg - 12) / 12));
  const fade = 1 - t * t * (3 - 2 * t);
  return Math.max(0, blades / y - 1) * fade;
}

export const SKY_ORDER = Object.freeze(['morning', 'midday', 'golden', 'overcast', 'fog']);
export const DEFAULT_SKY = 'midday';

export function parseSkySetting(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return SKY_ORDER.includes(v) ? v : DEFAULT_SKY;
}

export function nextSkySetting(value) {
  const i = SKY_ORDER.indexOf(parseSkySetting(value));
  return SKY_ORDER[(i + 1) % SKY_ORDER.length];
}

export function skyLabel(value) {
  return SKY_PRESETS[parseSkySetting(value)].label;
}
