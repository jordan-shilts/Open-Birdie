'use strict';
// Playing conditions: wind, the air (temperature, altitude, humidity), how firm the
// ground is and how fast the greens run. The game plays every shot in them
// (lib/physics.js simulateShot options) and the lineup predicts in them (lib/predict.js).
//
//   windMph      0..40     steady wind speed
//   windFromDeg  0..359    compass bearing the wind blows FROM (0 = from the north)
//   gustMph      0..20     each real shot meets a gust in [-gustMph, +gustMph] on top
//                          of the steady wind (seeded by the shot); predictions use the
//                          steady wind
//   tempF        20..110   air temperature
//   altitudeFt   -300..10000
//   humidity     0..100    relative humidity, %
//   firmness     0..1      0 soft (plugs, stops), 0.5 normal, 1 firm / links
//   greenStimp   7..15     green speed, Stimpmeter feet
//
// The defaults are standard conditions and reproduce the physics exactly as it was
// before conditions existed: calm, 70 F, sea level, 50 %, firmness 0.5, stimp 10.5.

const fs = require('fs');
const path = require('path');
const { MPH, RHO } = require('./physics');

// [min, max, decimals]; windFromDeg wraps around the compass instead of clamping.
const FIELDS = Object.freeze({
  windMph: [0, 40, 1],
  windFromDeg: [0, 359, 0],
  gustMph: [0, 20, 1],
  tempF: [20, 110, 1],
  altitudeFt: [-300, 10000, 0],
  humidity: [0, 100, 0],
  firmness: [0, 1, 2],
  greenStimp: [7, 15, 1],
});
const KEYS = Object.freeze(Object.keys(FIELDS));

const DEFAULTS = Object.freeze({
  windMph: 0, windFromDeg: 0, gustMph: 0, tempF: 70, altitudeFt: 0, humidity: 50, firmness: 0.5, greenStimp: 10.5,
});

const PRESET_LIST = [
  ['calm', 'Calm', 'Standard conditions: no wind, 70°F, sea level', {}],
  ['breezy', 'Breezy', '8 mph from the southwest', { windMph: 8, windFromDeg: 225 }],
  ['windy', 'Windy', '16 mph from the west', { windMph: 16, windFromDeg: 270 }],
  ['gale', 'Gale', '25 mph from the northwest, gusting ±8, firm ground', { windMph: 25, windFromDeg: 315, gustMph: 8, firmness: 0.8 }],
  ['hot', 'Hot', '95°F, firm and running', { tempF: 95, firmness: 0.7 }],
  ['cold', 'Cold', '45°F, soft ground', { tempF: 45, firmness: 0.3 }],
  ['mile-high', 'Mile high', '5,280 ft: thin air', { altitudeFt: 5280 }],
  ['links', 'Links', '18 mph from the west-southwest, 60°F, firm, slower greens', { windMph: 18, windFromDeg: 240, tempF: 60, firmness: 1, greenStimp: 9.5 }],
];
const PRESETS = Object.freeze(PRESET_LIST.map(([id, label, description, values]) => Object.freeze({
  id, label, description, values: Object.freeze({ ...DEFAULTS, ...values }),
})));

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundTo(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function cleanField(key, v) {
  const [min, max, decimals] = FIELDS[key];
  if (key === 'windFromDeg') return ((Math.round(v) % 360) + 360) % 360;
  const r = roundTo(Math.min(max, Math.max(min, v)), decimals);
  return r === 0 ? 0 : r;   // no -0
}

/**
 * Conditions from any input: every known field validated, clamped and rounded onto
 * `base` (the defaults unless given); unknown fields and bad values are ignored.
 */
function normalizeConditions(input, base = DEFAULTS) {
  const out = {};
  for (const key of KEYS) {
    const b = base && toNumber(base[key]);
    out[key] = b === null || b === undefined ? DEFAULTS[key] : cleanField(key, b);
  }
  if (input && typeof input === 'object') {
    for (const key of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const v = toNumber(input[key]);
      if (v !== null) out[key] = cleanField(key, v);
    }
  }
  return out;
}

function presetById(id) {
  return PRESETS.find((p) => p.id === String(id || '').trim().toLowerCase()) || null;
}

function sameValues(a, b) {
  return KEYS.every((k) => a[k] === b[k]);
}

// The preset these values still are, or null once anything was changed.
function matchPreset(values) {
  const p = PRESETS.find((x) => sameValues(x.values, values));
  return p ? p.id : null;
}

function isStandard(values) {
  return sameValues(values, DEFAULTS);
}

/**
 * New conditions from what the API or the game was handed:
 *   'windy'                         a preset (all of its values)
 *   { preset: 'windy', windMph: 20 } a preset, then any fields on top
 *   { windMph: 12 }                  a change to the current conditions
 * Throws on an unknown preset.
 */
function resolveConditions(input, current = DEFAULTS) {
  if (typeof input === 'string') input = { preset: input };
  if (!input || typeof input !== 'object') return normalizeConditions(null, current);
  let base = current;
  if (input.preset !== undefined && input.preset !== null && input.preset !== '') {
    const p = presetById(input.preset);
    if (!p) {
      const err = new Error(`Unknown conditions preset: ${String(input.preset).slice(0, 40)}`);
      err.code = 'UNKNOWN_PRESET';
      throw err;
    }
    base = p.values;
  }
  return normalizeConditions(input, base);
}

// ---------- air ----------
// Moist air density (kg/m^3): pressure from the standard-atmosphere barometric formula
// at the altitude, water vapour from the relative humidity (Buck's saturation
// pressure), ideal-gas mixture of dry air and vapour at the temperature. The game
// NORMALISES it so the default conditions give exactly lib/physics.js RHO (1.225, the
// flight model's calibration density): airDensity = 1.225 * rho(c) / rho(defaults).
const RD = 287.058;    // J/(kg K), dry air
const RV = 461.495;    // J/(kg K), water vapour
function moistAirDensity(c) {
  const tK = (c.tempF - 32) * 5 / 9 + 273.15;
  const tC = tK - 273.15;
  const hM = c.altitudeFt * 0.3048;
  const p = 101325 * Math.pow(1 - 2.25577e-5 * hM, 5.25588);
  const psat = 611.21 * Math.exp((18.678 - tC / 234.5) * (tC / (257.14 + tC)));
  const pv = Math.min(1, Math.max(0, c.humidity / 100)) * psat;
  return (p - pv) / (RD * tK) + pv / (RV * tK);
}
const RHO_DEFAULTS = moistAirDensity(DEFAULTS);

function airDensity(c) {
  return RHO * (moistAirDensity(normalizeConditions(c)) / RHO_DEFAULTS);
}

// The conditions as the game state shows them: the values, the preset they still
// match (or null) and the air density the ball flies through.
function conditionsState(c) {
  const v = normalizeConditions(c);
  return { ...v, presetId: matchPreset(v), airDensity: Math.round(airDensity(v) * 10000) / 10000 };
}

/**
 * lib/physics.js simulateShot options for these conditions. gust: true for a real
 * shot (it meets a gust seeded from the shot), false for a prediction (steady wind).
 * Default conditions give options that reproduce the standard physics bit for bit.
 */
function physicsOptions(c, { gust = false } = {}) {
  const v = normalizeConditions(c);
  const gustMps = gust && v.gustMph > 0 ? v.gustMph * MPH : 0;
  return {
    wind: v.windMph > 0 || gustMps > 0 ? { speedMps: v.windMph * MPH, fromDeg: v.windFromDeg, gustMps } : null,
    airDensity: airDensity(v),
    firmness: v.firmness,
    greenStimp: v.greenStimp,
  };
}

// The wind a simulated ball met (simulateShot's windMps / gustMps), for a shot result:
// { speedMph (gust included), fromDeg, gustMph (+ stronger / - weaker than steady) }.
function shotWind(sim, c) {
  const r1 = (v) => Math.round(v * 10) / 10 || 0;
  return {
    speedMph: r1((sim && sim.windMps || 0) / MPH),
    fromDeg: normalizeConditions(c).windFromDeg,
    gustMph: r1((sim && sim.gustMps || 0) / MPH),
  };
}

// ---------- persistence (DATA_DIR/conditions.json) ----------
// A missing or unreadable file is ignored: the game starts in standard conditions.
function loadConditionsFile(file, log = console) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`[conditions] cannot read ${path.basename(file)}: ${err.message}`);
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return normalizeConditions(data.conditions && typeof data.conditions === 'object' ? data.conditions : data);
  } catch (err) {
    log.warn(`[conditions] ignoring ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

function saveConditionsFile(file, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, conditions: normalizeConditions(c) }, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  DEFAULTS,
  FIELDS,
  PRESETS,
  airDensity,
  conditionsState,
  isStandard,
  loadConditionsFile,
  matchPreset,
  moistAirDensity,
  normalizeConditions,
  physicsOptions,
  presetById,
  resolveConditions,
  saveConditionsFile,
  shotWind,
};
