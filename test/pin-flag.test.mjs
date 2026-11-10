// The flag in the wind (public/render/pin-flag.js): how hard the wind blows on the cloth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagWind01 } from '../public/render/pin-flag.js';

test('a calm hangs the flag, a gale pulls it taut, and it rises steadily between', () => {
  assert.equal(flagWind01(0), 0);
  assert.equal(flagWind01(25), 1);
  assert.equal(flagWind01(40), 1, 'past a gale it cannot blow harder on the cloth');
  let last = -1;
  for (let mph = 0; mph <= 25; mph += 1) {
    const v = flagWind01(mph);
    assert.ok(v > last, `stronger at ${mph} mph`);
    last = v;
  }
});

test('the conditions presets land where the cloth changes character', () => {
  // the shader hangs the cloth below 0.04 and has it fully out by 0.42 (flagCloth)
  assert.ok(flagWind01(0) < 0.04, 'Calm: hanging');
  assert.ok(flagWind01(8) > 0.2 && flagWind01(8) < 0.42, 'Breezy: lifting, not yet streaming');
  assert.ok(flagWind01(16) >= 0.42, 'Windy: streaming');
});

test('a missing or broken wind speed is a calm, never NaN on the GPU', () => {
  for (const v of [undefined, null, NaN, -5, 'x']) assert.equal(flagWind01(v), 0);
});
