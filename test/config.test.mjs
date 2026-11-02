import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_CONFIG } from '../public/render/config.js';

test('tier-0 systems default on, heavy/stretch systems default off', () => {
  assert.equal(RENDER_CONFIG.hdriEnv, true);
  assert.equal(RENDER_CONFIG.groundedSky, false); // disabled with the puresky HDRI (no ground to project)
  assert.equal(RENDER_CONFIG.aerialFog, true);
  assert.equal(RENDER_CONFIG.volumetricClouds, false);
  assert.equal(RENDER_CONFIG.dof, false);
});

test('exposure + env intensity are numbers in sane range', () => {
  assert.ok(RENDER_CONFIG.toneMappingExposure > 0 && RENDER_CONFIG.toneMappingExposure < 3);
  assert.ok(RENDER_CONFIG.environmentIntensity > 0 && RENDER_CONFIG.environmentIntensity <= 2);
});

test('sun azimuth follows the HDRI; altitude is pinned low enough for long, readable shadows', () => {
  assert.equal(RENDER_CONFIG.sunAzimuthDeg, null);
  assert.ok(RENDER_CONFIG.sunAltitudeDeg >= 20 && RENDER_CONFIG.sunAltitudeDeg <= 60, `altitude ${RENDER_CONFIG.sunAltitudeDeg}`);
});

test('daylight is sun-dominant: the sun outweighs the sky fill', () => {
  assert.ok(RENDER_CONFIG.sunIntensity / RENDER_CONFIG.environmentIntensity >= 6);
});
