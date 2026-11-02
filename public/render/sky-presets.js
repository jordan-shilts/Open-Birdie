// Time of day: one setting picks the sky photo (HDRI) and the light that goes with
// it. Pure (no three, no DOM) so the presets and the setting cycle are unit-tested
// (test/sky-presets.test.mjs).
//
// The sun's direction always comes from the sky photo itself (its brightest texel,
// hdri-analyze.js), so shadows fall away from the bright part of the sky. Midday
// keeps its lowered 36 deg sun (long, readable tree shadows under a high summer sun)
// and ships with the app; morning and golden hour are CC0 Poly Haven skies fetched
// when first picked, so the install stays small, with midday as the fallback when
// one can't be fetched.

const POLY_HAVEN_4K = (id) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/${id}_4k.hdr`;

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
    sunAltitudeDeg: 36,
    sunColor: '#fff4e0',
    sunIntensity: 5.0,
    environmentIntensity: 0.4,
    exposure: 0.7,
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
});

export const SKY_ORDER = Object.freeze(['morning', 'midday', 'golden']);
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
