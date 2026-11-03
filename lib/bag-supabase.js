'use strict';
// The player's bag in Supabase: the store lib/bag.js picks when the data dir has a
// supabase.json: {"url": "https://<ref>.supabase.co", "key": "<publishable key>"}
// (optional "player": whose bag this is, "default" when unset).
//
// Every shot is a row in the project's shots table, and a reset is a marker row in
// bag_resets, so the game's key (the publishable key, which may only read and insert:
// supabase/migrations/) never updates or deletes anything. The bag is read back from
// the bag_shots view: the player's shots after their latest reset, the last 30 of each
// club. Plain fetch against the REST API (PostgREST); no client library.
//
// Offline first: a change lands on disk before anything is sent. The bag goes to the
// JSON file store (bag.json, the copy the game reads whenever Supabase cannot be
// reached) and the rows still to send go to bag-outbox.json. The outbox is sent in the
// background, and again with a backoff until Supabase takes it. load() sends what is
// waiting, reads the bag from Supabase and adds what is still waiting. A row's id is a
// hash of the row, so a row sent twice (or a bag carried over twice) is stored once.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MAX_PER_CLUB, cleanShot } = require('./bag');

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;           // first retry after a failed sync; doubles up to MAX_RETRY_MS
const MAX_RETRY_MS = 5 * 60_000;
const BATCH = 500;                // rows per insert
const PLAYER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const COLUMNS = 'id,club,speed_mph,vla,hla,total_spin,spin_axis,at,course,hole,lie,practice,club_name';
const META_COLUMNS = [['course', 'course'], ['hole', 'hole'], ['lie', 'lie'], ['practice', 'practice'], ['clubName', 'club_name']];

class SupabaseError extends Error {
  // kind: 'refused' (the database turned the row down: sending it again cannot help)
  // or 'unavailable' (no network, a timeout, a server error, a wrong key or a missing
  // table: it may pass later)
  constructor(kind, message) {
    super(message);
    this.name = 'SupabaseError';
    this.kind = kind;
  }
}

// A key that bypasses every policy: a new secret key, or a legacy service_role JWT.
function isSecretKey(key) {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (!payload) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role === 'service_role'; } catch (_) { return false; }
}

// { url, key, player } from supabase.json, or null (no file, or not usable: the bag then
// stays in the file alone). Never logs the file's contents: they hold the key.
function readSupabaseConfig(file, log = console) {
  const name = path.basename(file);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`[bag] cannot read ${name}: ${err.code || 'error'}`);
    return null;
  }
  let saved;
  try { saved = JSON.parse(raw); } catch (_) {
    log.warn(`[bag] ignoring ${name}: not valid JSON`);
    return null;
  }
  let url = null;
  try { url = new URL(String(saved && saved.url || '').trim()); } catch (_) { url = null; }
  const key = String(saved && saved.key || '').trim();
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !key) {
    log.warn(`[bag] ignoring ${name}: it needs "url" (https://<ref>.supabase.co) and "key" (the publishable key)`);
    return null;
  }
  if (isSecretKey(key)) {
    log.warn(`[bag] ignoring ${name}: its key is a secret key, which bypasses every policy; use the publishable key`);
    return null;
  }
  const player = saved.player === undefined || saved.player === null ? 'default' : String(saved.player);
  if (!PLAYER_RE.test(player)) {
    log.warn(`[bag] ignoring ${name}: "player" may only use letters, digits, ".", "_" and "-" (at most 64)`);
    return null;
  }
  return { url: url.origin, key, player };
}

// A UUID-shaped hash: the same shot (or reset) always gets the same id.
function rowId(parts) {
  const h = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// A clean shot (lib/bag.js cleanShot) as a shots row. Every column is present (null
// when unknown): PostgREST takes a bulk insert's columns from its first row.
function shotRow(player, shot) {
  const row = {
    id: rowId([player, shot.club, shot.at, shot.speedMph, shot.vla, shot.hla, shot.totalSpin, shot.spinAxis]),
    player,
    club: shot.club,
    speed_mph: shot.speedMph,
    vla: shot.vla,
    hla: shot.hla,
    total_spin: shot.totalSpin,
    spin_axis: shot.spinAxis,
    at: new Date(shot.at).toISOString(),
  };
  for (const [key, column] of META_COLUMNS) row[column] = shot[key] ?? null;
  return row;
}

function resetRow(player, at) {
  return { id: rowId([player, 'reset', at]), player, at: new Date(at).toISOString() };
}

// A row of shots (or bag_shots) as a clean shot, or null.
function fromRow(r) {
  if (!r || typeof r !== 'object') return null;
  const shot = { club: r.club, speedMph: r.speed_mph, vla: r.vla, hla: r.hla, totalSpin: r.total_spin, spinAxis: r.spin_axis, at: Date.parse(r.at) };
  for (const [key, column] of META_COLUMNS) if (r[column] !== null && r[column] !== undefined) shot[key] = r[column];
  return Number.isFinite(shot.at) ? cleanShot(shot) : null;
}

const validDate = (ms) => Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime());

// Whether an error answer means the database turned the rows down: a data or
// constraint error (SQLSTATE class 22 or 23), or a row-level security check.
function refusedRows(status, detail) {
  const code = String(detail && detail.code || '');
  if (status === 400 || status === 409 || status === 422) return /^2[23]/.test(code);
  if (status === 401 || status === 403) return code === '42501' && /row-level security/i.test(String(detail.message || ''));
  return false;
}

function createSupabaseStore({
  url, key, player = 'default', cache, outboxFile,
  maxPerClub = MAX_PER_CLUB, fetchImpl = fetch, now = Date.now, log = console,
  timeoutMs = REQUEST_TIMEOUT_MS, retryMs = RETRY_MS,   // retryMs null: no automatic retry
} = {}) {
  if (!url || !key || !cache || !outboxFile) throw new TypeError('createSupabaseStore needs url, key, cache and outboxFile');
  if (!PLAYER_RE.test(player)) throw new TypeError(`createSupabaseStore: bad player "${player}"`);
  const rest = `${String(url).replace(/\/+$/, '')}/rest/v1`;
  let outbox = null;        // rows still to send, oldest first: { table, row }
  let opening = null;
  let syncing = null;       // the sync in flight
  let retryTimer = null;
  let failures = 0;         // failed syncs in a row (the retry backs off)
  let reachable = null;     // whether the last request got through (null: none yet)

  const info = (message) => { if (typeof log.info === 'function') log.info(message); };

  function saveOutbox() {
    fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
    const tmp = `${outboxFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rows: outbox }));
    fs.renameSync(tmp, outboxFile);
  }

  // The outbox from disk. With none yet (Supabase newly set up, or the file lost), the
  // bag kept in bag.json so far is queued: the row ids make sending it again harmless.
  function openOutbox() {
    if (!opening) {
      opening = (async () => {
        let rows = null;
        try {
          const data = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
          if (!data || !Array.isArray(data.rows)) throw new Error('no rows list');
          rows = data.rows.filter((o) => o && (o.table === 'shots' || o.table === 'bag_resets') && o.row && typeof o.row.id === 'string');
        } catch (err) {
          if (err.code !== 'ENOENT') {
            log.warn(`[bag] ignoring ${path.basename(outboxFile)}: ${err instanceof SyntaxError ? 'not valid JSON' : err.message}`);
            try { fs.renameSync(outboxFile, `${outboxFile}.corrupt`); } catch (_) { /* leave it */ }
          }
        }
        if (rows) {
          outbox = rows;
        } else {
          outbox = (await cache.load()).filter((s) => validDate(s.at)).map((s) => ({ table: 'shots', row: shotRow(player, s) }));
          saveOutbox();
        }
        return outbox;
      })();
      opening.catch(() => { opening = null; });
    }
    return opening;
  }

  function noteReachable(ok, reason) {
    if (ok && reachable === false) info('[bag] Supabase is reachable again');
    if (!ok && reachable !== false) {
      log.warn(`[bag] ${reason}; shots are kept on this computer${outbox && outbox.length ? ` (${outbox.length} waiting)` : ''} and sent when Supabase answers`);
    }
    reachable = ok;
  }

  async function request(pathAndQuery, { method = 'GET', body, prefer } = {}) {
    const headers = { apikey: key, Accept: 'application/json' };   // a publishable key goes on apikey alone
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetchImpl(`${rest}${pathAndQuery}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const why = err && err.name === 'TimeoutError' ? 'timed out' : (err && err.cause && err.cause.code) || (err && err.message) || 'error';
      throw new SupabaseError('unavailable', `cannot reach Supabase (${why})`);
    }
    if (res.ok) return res;
    let detail = null;
    try { detail = await res.json(); } catch (_) { detail = null; }
    const message = detail && typeof detail.message === 'string' ? `: ${detail.message.slice(0, 200)}` : '';
    throw new SupabaseError(refusedRows(res.status, detail) ? 'refused' : 'unavailable', `Supabase answered HTTP ${res.status}${message}`);
  }

  // Insert rows (a row already there is skipped). A batch the database turns down is
  // sent row by row, so one bad row cannot hold the rest back. Returns the rows turned
  // down on their own; throws when Supabase cannot take them now.
  async function insert(table, items) {
    try {
      await request(`/${table}`, { method: 'POST', body: items.map((o) => o.row), prefer: 'return=minimal,resolution=ignore-duplicates' });
      return [];
    } catch (err) {
      if (err.kind !== 'refused') throw err;
      if (items.length === 1) return [{ item: items[0], reason: err.message }];
      const refused = [];
      for (const item of items) refused.push(...await insert(table, [item]));
      return refused;
    }
  }

  // Send the outbox, resets first. True when nothing is left waiting.
  async function sendOutbox() {
    await openOutbox();
    for (const table of ['bag_resets', 'shots']) {
      for (let batch; (batch = outbox.filter((o) => o.table === table).slice(0, BATCH)).length;) {
        const refused = await insert(table, batch);
        const done = new Set(batch);
        outbox = outbox.filter((o) => !done.has(o));
        saveOutbox();
        for (const { item, reason } of refused) {
          log.warn(`[bag] Supabase refused ${table === 'shots' ? `a ${item.row.club} shot` : 'a bag reset'} of ${item.row.at}, dropped: ${reason}`);
        }
      }
    }
    return outbox.length === 0;
  }

  function scheduleRetry() {
    if (retryMs === null || retryTimer) return;
    const delay = Math.min(MAX_RETRY_MS, retryMs * 2 ** Math.min(failures - 1, 16));
    retryTimer = setTimeout(() => { retryTimer = null; sync(); }, delay);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  // Send what waits (rows added meanwhile too). Resolves true once the outbox is empty,
  // false when Supabase cannot take it now (a retry is then scheduled); never rejects.
  function sync() {
    if (!syncing) {
      syncing = (async () => {
        clearTimeout(retryTimer);
        retryTimer = null;
        try {
          while (!(await sendOutbox())) { /* changes came in while sending: send those too */ }
          if (failures) noteReachable(true);
          failures = 0;
          return true;
        } catch (err) {
          failures++;
          if (err instanceof SupabaseError) noteReachable(false, err.message);
          else log.warn(`[bag] could not send the shot history to Supabase: ${err.message}`);
          scheduleRetry();
          return false;
        }
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  async function fetchBag() {
    const query = new URLSearchParams({ select: COLUMNS, player: `eq.${player}`, rank: `lte.${maxPerClub}`, order: 'at.asc,id.asc' });
    const res = await request(`/bag_shots?${query}`);
    let rows;
    try { rows = await res.json(); } catch (_) { rows = null; }
    if (!Array.isArray(rows)) throw new SupabaseError('unavailable', 'Supabase sent the bag in an unexpected form');
    return rows;
  }

  // The bag from Supabase plus what still waits here: the shots it does not have yet,
  // less whatever a waiting reset cleared.
  function merge(rows) {
    const have = new Set(rows.map((r) => r && r.id));
    const waiting = outbox.filter((o) => o.table === 'shots' && !have.has(o.row.id)).map((o) => o.row);
    const resetAt = Math.max(-Infinity, ...outbox.filter((o) => o.table === 'bag_resets').map((o) => Date.parse(o.row.at)));
    return [...rows, ...waiting].map(fromRow).filter((s) => s && s.at > resetAt).sort((a, b) => a.at - b.at);
  }

  return {
    kind: 'supabase',
    url: String(url),
    player,

    async load() {
      await openOutbox();
      // Supabase cannot take what waits: it cannot answer for the bag either
      if (!(await sync())) return cache.load();
      let rows;
      try {
        rows = await fetchBag();
        noteReachable(true);
      } catch (err) {
        noteReachable(false, err.message);
        return cache.load();
      }
      const shots = merge(rows);
      await cache.replace(shots);
      return shots;
    },

    async append(club, launch, meta = {}) {
      await openOutbox();
      const shot = cleanShot({ ...meta, ...launch, club }, now);
      if (!shot || !validDate(shot.at)) return;
      outbox.push({ table: 'shots', row: shotRow(player, shot) });
      saveOutbox();
      await cache.append(shot.club, shot);
      sync();
    },

    // at: when the player reset (lib/bag.js passes it, so a shot hit after the reset
    // but stored before it is not cleared); now when not given.
    async reset({ at } = {}) {
      await openOutbox();
      outbox.push({ table: 'bag_resets', row: resetRow(player, validDate(at) ? Math.round(at) : now()) });
      saveOutbox();
      await cache.reset();
      sync();
    },

    sync,
    // How many changes wait to be sent (null before the outbox is first read).
    get pending() { return outbox ? outbox.length : null; },
    get reachable() { return reachable; },
    close() {
      clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

module.exports = {
  SupabaseError,
  createSupabaseStore,
  fromRow,
  isSecretKey,
  readSupabaseConfig,
  resetRow,
  rowId,
  shotRow,
};
