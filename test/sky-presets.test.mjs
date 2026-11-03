// Time-of-day presets (public/render/sky-presets.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKY_PRESETS, SKY_ORDER, DEFAULT_SKY, parseSkySetting, nextSkySetting, skyLabel } from '../public/render/sky-presets.js';

test('every preset carries a full, plausible light rig', () => {
  for (const k of SKY_ORDER) {
    const p = SKY_PRESETS[k];
    assert.ok(p.label);
    assert.match(p.sunColor, /^#[0-9a-f]{6}$/i);
    assert.ok(p.sunIntensity > 1 && p.sunIntensity < 10);
    // the sun is the key light, the sky photo fill (see config.test.mjs)
    assert.ok(p.sunIntensity / p.environmentIntensity >= 6, `${k} sun/env ratio`);
    assert.ok(p.exposure > 0.4 && p.exposure < 1.5);
    assert.ok(p.fogDensity > 0 && p.fogDensity < 0.002);
    if (p.hdri) assert.match(p.hdri, /^https:\/\/dl\.polyhaven\.org\/.+_4k\.hdr$/);
  }
});

test('midday ships with the app; the others are fetched when picked', () => {
  assert.equal(SKY_PRESETS[DEFAULT_SKY].hdri, null);
  assert.ok(SKY_ORDER.filter((k) => k !== DEFAULT_SKY).every((k) => SKY_PRESETS[k].hdri));
});

test('golden hour is warmer than midday', () => {
  const warmth = (hex) => parseInt(hex.slice(1, 3), 16) - parseInt(hex.slice(5, 7), 16);
  assert.ok(warmth(SKY_PRESETS.golden.sunColor) > warmth(SKY_PRESETS.midday.sunColor) + 40);
});

test('settings parse, fall back and cycle', () => {
  assert.equal(parseSkySetting('GOLDEN'), 'golden');
  assert.equal(parseSkySetting('dusk'), DEFAULT_SKY);
  assert.equal(parseSkySetting(null), DEFAULT_SKY);
  const seen = new Set();
  let s = 'morning';
  for (let i = 0; i < SKY_ORDER.length; i++) { seen.add(s); s = nextSkySetting(s); }
  assert.equal(s, 'morning');
  assert.equal(seen.size, SKY_ORDER.length);
  assert.equal(skyLabel('golden'), 'Golden hour');
});
