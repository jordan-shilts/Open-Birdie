'use strict';
// Round settings the player picks in the menu, kept across restarts in
// BIRDIE_DATA_DIR/settings.json (a bad or missing file: the defaults).
//
//   gimmeFt   0..10   a ball that stops on the green this close to the cup is given
//                     (holed, +1 stroke); 0 = every putt is holed out
//   units     'yd'    the yardage unit (only yards for now)
//
// gimmeYd is the old name of gimmeFt: it always held feet, and a body or file that
// still uses it is read as gimmeFt.

const fs = require('fs');
const path = require('path');

const GIMME_MAX_FT = 10;
const DEFAULTS = Object.freeze({ gimmeFt: 8, units: 'yd' });

function badSetting(message) {
  const err = new Error(message);
  err.code = 'BAD_SETTING';
  return err;
}

// The settings after applying `patch` on top of `current`; throws BAD_SETTING on a
// value it can't use. Unknown keys are ignored.
function normalizeSettings(patch, current = DEFAULTS) {
  const out = { ...DEFAULTS, ...current };
  delete out.gimmeYd;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  const g = 'gimmeFt' in patch ? patch.gimmeFt : patch.gimmeYd;
  if (g !== undefined) {
    const n = typeof g === 'string' && g.trim() !== '' ? Number(g) : g;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw badSetting('gimmeFt must be a number of feet');
    out.gimmeFt = Math.round(Math.max(0, Math.min(GIMME_MAX_FT, n)) * 2) / 2;
  }
  if (patch.units !== undefined) {
    if (patch.units !== 'yd') throw badSetting('units must be yd');
    out.units = 'yd';
  }
  return out;
}

function loadSettingsFile(file, log = console) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`[settings] cannot read ${path.basename(file)}: ${err.message}`);
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return normalizeSettings(data.settings && typeof data.settings === 'object' ? data.settings : data);
  } catch (err) {
    log.warn(`[settings] ignoring ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

function saveSettingsFile(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: normalizeSettings(s) }, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, GIMME_MAX_FT, normalizeSettings, loadSettingsFile, saveSettingsFile };
