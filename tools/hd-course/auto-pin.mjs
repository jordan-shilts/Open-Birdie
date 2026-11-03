// Auto-pinned HD hole manifests.
//
// A reviewed manifest (manifests/*.json) pins the NAIP acquisition a hole is built
// from. For a hole without one, this picks the newest single-date NAIP acquisition
// whose tiles cover the hole's padded bounds and pins it the same way (date, item ids,
// GSD); the build then resolves it like any other manifest (discover.mjs: fingerprint,
// snapped bounds, asset drift). Also re-pins a manifest whose acquisition is gone from
// the catalog.
//
//   node tools/hd-course/auto-pin.mjs --course <cache.json> [--holes 1,2|all] [--write]
//   node tools/hd-course/auto-pin.mjs --repin <manifest.json> --course <cache.json> [--write]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { holeExtent } from './discover.mjs';
import { searchNaipCandidates } from './naip.mjs';
import { loadManifest, parseManifest } from './config.mjs';
import { loadCourseFile } from './course-source.mjs';
import { HdCompileError } from './errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELEVATION = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';

// 1 m 3DEP lidar covers most of the US. Where the export comes back coarser
// (HD_3DEP_COARSE: older lidar, like Bandon's 2008 flight) a hole is built again on
// COARSE_TERRAIN, which keeps the 3.4 m native gate and 600 px exports.
export const AUTO_TERRAIN = Object.freeze({ targetSpacingM: 1, nativeSpacingM: 1, maxPx: 1200, crs: 'EPSG:3857' });
export const COARSE_TERRAIN = Object.freeze({ targetSpacingM: 3, crs: 'EPSG:3857' });
const SAMPLES = 5;   // coverage is checked on a 5 x 5 grid over the hole's bounds

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export function autoManifestTemplate(course, hole, { terrain = AUTO_TERRAIN, padding = 45 } = {}) {
  return {
    schemaVersion: 1,
    course: {
      name: course.name,
      cacheVersion: course.version,
      fingerprintVersion: 2,
      courseId: course.source.courseId,
      fingerprint: 'pending',
    },
    hole,
    padding,
    terrain: { ...terrain },
    imagery: { collection: 'naip', date: '1970-01-01', gsdM: 0.6, itemIds: ['unpinned'] },
    providers: { elevation: ELEVATION, imagery: STAC },
    limits: { maxPixels: 80_000_000, maxDownloadBytes: 3_221_225_472, maxBundleBytes: 157_286_400 },
    normalization: { format: 'webp', quality: 90 },
    discovered: { state: 'pending' },
  };
}

function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Does a STAC item's footprint (GeoJSON Polygon/MultiPolygon, else its bbox) cover a point?
function covers(feature, lon, lat) {
  const g = feature.geometry;
  const polygons = g && g.type === 'Polygon' ? [g.coordinates] : g && g.type === 'MultiPolygon' ? g.coordinates : null;
  if (polygons) return polygons.some((p) => inRing(p[0], lon, lat) && !p.slice(1).some((hole) => inRing(hole, lon, lat)));
  const b = feature.bbox;
  return Array.isArray(b) && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

const overlaps = (feature, bbox) => {
  const b = feature.bbox;
  if (!Array.isArray(b)) return true;
  return b[0] <= bbox.east && b[2] >= bbox.west && b[1] <= bbox.north && b[3] >= bbox.south;
};

// The newest acquisition date whose items together cover `bbox` (and share one GSD),
// as the manifest's imagery pin { date, gsdM, itemIds }; null when no date does.
export function pickAcquisition(features, bbox) {
  const byDate = new Map();
  for (const f of features || []) {
    const props = f.properties || {};
    const date = String(props.datetime || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || props.gsd == null || props['proj:epsg'] == null) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(f);
  }
  const points = [];
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      points.push([bbox.west + ((bbox.east - bbox.west) * i) / (SAMPLES - 1), bbox.south + ((bbox.north - bbox.south) * j) / (SAMPLES - 1)]);
    }
  }
  for (const date of [...byDate.keys()].sort().reverse()) {
    const items = byDate.get(date).filter((f) => overlaps(f, bbox));
    if (!items.length || !points.every(([lon, lat]) => items.some((f) => covers(f, lon, lat)))) continue;
    const gsds = [...new Set(items.map((f) => f.properties.gsd))];
    if (gsds.length !== 1) continue;
    return { date, gsdM: gsds[0], itemIds: items.map((f) => f.id).sort() };
  }
  return null;
}

async function pin(manifest, course, search) {
  const { bbox } = holeExtent(course, manifest);
  const pick = pickAcquisition(await search({ bbox, endpoint: manifest.providers.imagery }), bbox);
  if (!pick) throw new HdCompileError('discover-imagery', 'HD_NAIP_NO_COVERAGE', { hole: manifest.hole });
  return parseManifest({ ...manifest, imagery: { ...manifest.imagery, collection: 'naip', ...pick } });
}

// A pinned (still pending-discovery) manifest for one hole of `course`.
export async function autoPinManifest({ course, hole, terrain, padding, search = searchNaipCandidates }) {
  return pin(autoManifestTemplate(course, hole, { terrain, padding }), course, search);
}

// The same manifest pinned to the newest covering acquisition, back to pending discovery.
export async function repinManifest({ manifest, course, search = searchNaipCandidates }) {
  const { fingerprint, ...rest } = manifest.course;
  const pending = { ...manifest, course: { ...rest, fingerprint: 'pending' }, discovered: { state: 'pending' } };
  return pin(pending, course, search);
}

function parse(argv) {
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  return { opt, write: argv.includes('--write') };
}

export async function main(argv) {
  const { opt, write } = parse(argv);
  const course = loadCourseFile(opt('course'));
  const out = [];
  if (opt('repin')) {
    out.push({ file: opt('repin'), manifest: await repinManifest({ manifest: loadManifest(opt('repin')), course }) });
  } else {
    const wanted = !opt('holes') || opt('holes') === 'all'
      ? course.holes.map((h) => h.ref).filter((r) => Number.isInteger(r) && r >= 1 && r <= 18)
      : opt('holes').split(',').map(Number);
    for (const hole of wanted) {
      try {
        const manifest = await autoPinManifest({ course, hole });
        out.push({ file: path.join(HERE, 'manifests', `${slug(course.name)}-hole-${String(hole).padStart(2, '0')}.json`), manifest });
      } catch (error) {
        process.stderr.write(`hole ${hole}: ${error.code || error.message}\n`);
      }
    }
  }
  for (const { file, manifest } of out) {
    const line = `hole ${manifest.hole}: NAIP ${manifest.imagery.date} (${manifest.imagery.gsdM} m) ${manifest.imagery.itemIds.join(', ')}`;
    if (write) {
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(`${line}\n  -> ${path.relative(process.cwd(), file)}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
