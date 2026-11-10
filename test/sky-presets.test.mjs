// Time-of-day presets (public/render/sky-presets.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKY_PRESETS, SKY_ORDER, DEFAULT_SKY, parseSkySetting, nextSkySetting, skyLabel, lowSunLift } from '../public/render/sky-presets.js';

test('every preset carries a full, plausible light rig', () => {
  for (const k of SKY_ORDER) {
    const p = SKY_PRESETS[k];
    assert.ok(p.label);
    assert.match(p.sunColor, /^#[0-9a-f]{6}$/i);
    if (p.overcast) {
      // under cloud the sky is the light: a faint sun, shadows barely there
      assert.ok(p.sunIntensity > 0 && p.sunIntensity <= 1, `${k} sun under cloud`);
      assert.ok(p.sunIntensity / p.environmentIntensity <= 1.5, `${k} sun/env ratio`);
    } else {
      assert.ok(p.sunIntensity > 1 && p.sunIntensity < 10);
      // the sun is the key light, the sky photo fill (see config.test.mjs)
      assert.ok(p.sunIntensity / p.environmentIntensity >= 6, `${k} sun/env ratio`);
    }
    assert.ok(p.exposure > 0.4 && p.exposure < 1.5);
    assert.ok(p.fogDensity > 0 && p.fogDensity < (k === 'fog' ? 0.01 : 0.002));
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

// How much of a surface's colour the air has taken at a distance (atmosphere.js fog curve).
const fogAt = (density, m) => { const d = density * m; return 1 - Math.exp(-d * (0.2 + d)); };

test('weather: overcast is clear air under cloud, sea fog closes in', () => {
  assert.equal(skyLabel('overcast'), 'Overcast');
  assert.equal(skyLabel('fog'), 'Sea fog');
  assert.equal(parseSkySetting('FOG'), 'fog');
  const { midday, overcast, fog } = SKY_PRESETS;
  assert.ok(!midday.overcast && overcast.overcast && fog.overcast);
  // a green 150 m away is easy to see under cloud; the far tree line greys
  assert.ok(fogAt(overcast.fogDensity, 150) < 0.06);
  assert.ok(fogAt(overcast.fogDensity, 800) > fogAt(midday.fogDensity, 800) * 1.5);
  // in fog the ball at your feet and the next bunker are clear, the green fades, the far shore is gone
  assert.ok(fogAt(fog.fogDensity, 30) < 0.05);
  assert.ok(fogAt(fog.fogDensity, 150) > 0.3 && fogAt(fog.fogDensity, 150) < 0.6);
  assert.ok(fogAt(fog.fogDensity, 400) > 0.95);
  // a grey day is dimmer than a sunny one, not dark: the fill is raised to carry it
  assert.ok(overcast.environmentIntensity > midday.environmentIntensity);
});

test('a low sun lights standing grass far more than a level sheet; midday is left as tuned', () => {
  const at = (deg) => lowSunLift(Math.sin(deg * Math.PI / 180));
  assert.equal(at(SKY_PRESETS.midday.sunAltitudeDeg), 0, 'midday (24 degrees): unchanged');
  assert.equal(at(40), 0);
  assert.equal(at(90), 0);
  assert.ok(Math.abs(at(10) - 1.3) < 0.1, `about 2.3x at 10 degrees (${at(10)})`);
  // rises steadily as the sun sinks, with no jump where the fade starts
  let last = -1;
  for (let deg = 24; deg >= 4; deg -= 1) { const v = at(deg); assert.ok(v >= last, `more at ${deg}`); last = v; }
  assert.ok(at(23) < 0.02 && at(18) > 0.1);
  // bounded however low the sun, and never NaN
  assert.ok(lowSunLift(0) < 6 && lowSunLift(-1) < 6);
  for (const v of [NaN, undefined, null]) assert.equal(lowSunLift(v), 0);
});
