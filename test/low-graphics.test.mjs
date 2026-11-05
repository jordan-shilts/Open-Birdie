// The frame-cost cuts made for the sim PC's integrated GPU (docs/machines.md): the HD
// ground in tiles, the quality scale on the ground's detail rings, the links tufts in
// culled cells, the grade inside the OutputPass, and what the Low preset leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildHdTerrainLod, updateTerrainLod } from '../public/render/hd-terrain.js';
import { buildGrass } from '../public/render/grass.js';
import { gradeInto } from '../public/render/postfx.js';
import { QUALITY_PRESETS } from '../public/render/quality.js';

const flat = (nx, ny, cellM = 1, minX = 0, minY = 0) => ({ minX, minY, cellM, nx, ny, heights: new Float32Array(nx * ny) });
const entries = (root) => { const out = []; root.traverse((o) => { if (o.userData?.lod) out.push(o.userData.lod); }); return out; };
const cam = (x, y, h = 2) => { const c = new THREE.PerspectiveCamera(); c.position.set(x, h, -y); return c; };

test('an HD patch is built as tiles, each with its own levels of detail', () => {
  // 300 x 200 cells at 1 m -> 3 x 2 tiles of up to 128 cells
  const root = buildHdTerrainLod({ grid: flat(301, 201), material: new THREE.MeshBasicMaterial(), uvBounds: { minX: 0, minY: 0, maxX: 300, maxY: 200 } });
  const tiles = entries(root);
  assert.equal(tiles.length, 6);
  for (const L of tiles) {
    assert.equal(L.meshes.length, 3, '1 m, 2 m and 4 m');
    assert.deepEqual(L.far, [240, 600]);
    const t = L.meshes.map((m) => m.geometry.getIndex().count);
    assert.ok(t[0] > t[1] && t[1] > t[2], 'each level is coarser');
  }
  // the tiles cover the patch: their footprints span 0..300 x 0..200
  assert.equal(Math.min(...tiles.map((L) => L.minX)), 0);
  assert.equal(Math.max(...tiles.map((L) => L.maxX)), 300);
  assert.equal(Math.max(...tiles.map((L) => L.maxY)), 200);
});

test('standing on one end of a long HD patch leaves its far tiles coarse', () => {
  const root = buildHdTerrainLod({ grid: flat(801, 101), material: new THREE.MeshBasicMaterial(), uvBounds: { minX: 0, minY: 0, maxX: 800, maxY: 100 } });
  updateTerrainLod(root, cam(5, 50));
  const levels = entries(root).sort((a, b) => a.minX - b.minX).map((L) => L.level);
  assert.equal(levels[0], 0, 'the tile underfoot at full detail');
  assert.equal(levels.at(-1), 2, 'the tile 650 m off at the coarsest');
  assert.ok(levels.every((v, i) => i === 0 || v >= levels[i - 1]), 'detail only falls with distance');
});

test('the quality scale brings the detail rings in', () => {
  const root = buildHdTerrainLod({ grid: flat(129, 129), material: new THREE.MeshBasicMaterial(), uvBounds: { minX: 0, minY: 0, maxX: 128, maxY: 128 } });
  const [L] = entries(root);
  const c = cam(128 + 200, 64);    // 200 m off the tile's edge
  updateTerrainLod(root, c, 1);
  assert.equal(L.level, 0);       // inside the 240 m ring
  updateTerrainLod(root, c, 0.6);
  assert.equal(L.level, 1);       // past 0.6 x 240 = 144 m
  assert.equal(L.meshes.filter((m) => m.visible).length, 1, 'one level shows at a time');
  updateTerrainLod(root, c, Number.NaN);   // a bad scale falls back to 1
  assert.equal(L.level, 0);
});

test('Low leaves out bloom and draws trees, ground detail and tufts less far', () => {
  const H = QUALITY_PRESETS.high, L = QUALITY_PRESETS.low;
  assert.equal(L.bloom, false);
  assert.equal(H.bloom, true);
  assert.ok(L.treeMidM < H.treeMidM && L.treeMidM > L.treeNearM);
  assert.equal(H.terrainLodScale, 1);
  assert.ok(L.terrainLodScale > 0 && L.terrainLodScale < 1);
  assert.ok(L.grassDrawM < H.grassDrawM);
});

test('fescue tufts in cells: the same blades, culled by distance', () => {
  const spots = [];
  for (let i = 0; i < 40; i++) spots.push({ x: (i % 20) * 30, y: Math.floor(i / 20) * 300, s: 1 });   // two rows 300 m apart
  const V = (x, y, z) => new THREE.Vector3(x, z, -y);
  const one = buildGrass(spots, () => 0, V, { perTuft: 4 });
  assert.ok(one.mesh.isInstancedMesh, 'without cellM: one mesh, as before');
  const cells = buildGrass(spots, () => 0, V, { perTuft: 4, cellM: 120 });
  assert.ok(cells.mesh.isGroup);
  const meshes = cells.mesh.children;
  assert.ok(meshes.length > 2);
  assert.equal(meshes.reduce((n, m) => n + m.count, 0), spots.length * 4, 'every blade is kept');
  assert.ok(meshes.every((m) => m.boundingSphere && m.boundingSphere.radius > 0), 'each cell has its own bounds to be culled by');
  cells.cull(cam(0, 0, 2), 150);
  const shown = meshes.filter((m) => m.visible);
  assert.ok(shown.length > 0 && shown.length < meshes.length);
  for (const m of shown) assert.ok(m.boundingSphere.center.distanceTo(new THREE.Vector3(0, 2, 0)) - m.boundingSphere.radius < 150);
  cells.cull(cam(0, 0, 2), Infinity);
  assert.ok(meshes.every((m) => m.visible));
});

test('the grade runs at the end of the OutputPass, after the sRGB encode', () => {
  const pass = gradeInto(new OutputPass());
  const fs = pass.material.fragmentShader;
  for (const u of ['uContrast', 'uSaturation', 'uVignette']) assert.ok(pass.material.uniforms[u], u);
  assert.equal(pass.uniforms, pass.material.uniforms, 'the pass and its material share uniforms');
  const enc = fs.indexOf('sRGBTransferOETF'), grade = fs.indexOf('* uContrast');
  assert.ok(enc > 0 && grade > enc, 'graded in display space');
  assert.ok(/uniform float uContrast, uSaturation, uVignette;/.test(fs));
  assert.equal(fs.trim().slice(-1), '}');
});

test('Low antialiases with FXAA, High keeps SMAA', () => {
  assert.equal(QUALITY_PRESETS.low.aa, 'fxaa');
  assert.equal(QUALITY_PRESETS.high.aa, 'smaa');
});
