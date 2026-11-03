'use strict';
// The player's bag in Supabase (lib/bag-supabase.js), against a fake of the project's
// REST API: shots and resets go in as rows (inserts only, never an update or a delete),
// the bag comes back from the bag_shots view, and with Supabase out of reach the game
// keeps recording into bag.json and the outbox and catches up later.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bag, createFileStore, createStore } = require('../lib/bag');
const { createSupabaseStore, isSecretKey, readSupabaseConfig, rowId } = require('../lib/bag-supabase');

const PROJECT = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'sb_publishable_TESTKEY_kept_out_of_every_log_0123';
const T0 = Date.UTC(2026, 10, 3, 15, 0, 0);
const launch = (speedMph, extra = {}) => ({ speedMph, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'birdie-bag-sb-'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jwt = (payload) => ['{"alg":"HS256"}', JSON.stringify(payload), 'sig'].map((p) => Buffer.from(p).toString('base64url')).join('.');

// A log that keeps every line, to check what was said and that the key never was.
function recorder() {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(String(m)), info: (m) => lines.push(String(m)) } };
}

// The project's REST API as the game uses it: POST /shots and /bag_resets insert (a
// duplicate id is skipped, and one refused row fails the whole request, as in Postgres),
// GET /bag_shots is the view. `down` drops every request like a lost network;
// `loseAnswers` stores the next n inserts but loses the answer; `status` answers every
// insert with that HTTP status; `refuse(table, row)` returns a database error for a row.
function fakeSupabase({ refuse = () => null } = {}) {
  const api = { tables: { shots: new Map(), bag_resets: new Map() }, requests: [], down: false, loseAnswers: 0, status: null };
  api.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    api.requests.push({ method, path: u.pathname });
    if (api.down) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    assert.equal(u.origin, PROJECT);
    assert.equal(init.headers.apikey, KEY);
    assert.equal(init.headers.Authorization, undefined, 'a publishable key goes on apikey alone');
    const name = u.pathname.replace(/^\/rest\/v1\//, '');
    if (method === 'POST') {
      assert.ok(name in api.tables, `insert into ${name}`);
      assert.equal(init.headers.Prefer, 'return=minimal,resolution=ignore-duplicates');
      if (api.status) return Response.json({ message: 'upstream unavailable' }, { status: api.status });
      const rows = JSON.parse(init.body);
      for (const row of rows) {
        const error = refuse(name, row);
        if (error) return Response.json(error, { status: 400 });
      }
      for (const row of rows) if (!api.tables[name].has(row.id)) api.tables[name].set(row.id, { ...row });
      if (api.loseAnswers > 0) { api.loseAnswers--; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
      return new Response(null, { status: 201 });
    }
    assert.equal(method, 'GET');
    assert.equal(name, 'bag_shots');
    return Response.json(bagView(api.tables, u.searchParams));
  };
  api.writes = () => api.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  return api;
}

// bag_shots (supabase/migrations/): the player's shots after their latest reset, the
// newest `rank` of each club, oldest first, timestamps as PostgREST writes them.
function bagView(tables, query) {
  const player = query.get('player').replace(/^eq\./, '');
  const maxRank = Number(query.get('rank').replace(/^lte\./, ''));
  assert.equal(query.get('order'), 'at.asc,id.asc');
  const time = (r) => Date.parse(r.at);
  const resetAt = Math.max(-Infinity, ...[...tables.bag_resets.values()].filter((r) => r.player === player).map(time));
  const live = [...tables.shots.values()].filter((s) => s.player === player && time(s) > resetAt);
  const bag = [];
  for (const club of new Set(live.map((s) => s.club))) {
    bag.push(...live.filter((s) => s.club === club).sort((a, b) => time(b) - time(a) || (b.id < a.id ? -1 : 1)).slice(0, maxRank));
  }
  bag.sort((a, b) => time(a) - time(b) || (a.id < b.id ? -1 : 1));
  const columns = query.get('select').split(',');
  return bag.map((s) => Object.fromEntries(columns.map((c) => [c, c === 'at' ? new Date(s.at).toISOString().replace(/(\.000)?Z$/, '+00:00') : s[c]])));
}

function openStore(dir, sb, { log, ...options } = {}) {
  return createSupabaseStore({
    url: PROJECT,
    key: KEY,
    cache: createFileStore(path.join(dir, 'bag.json'), { log }),
    outboxFile: path.join(dir, 'bag-outbox.json'),
    fetchImpl: sb.fetch,
    log,
    retryMs: null,
    ...options,
  });
}

const assertKeyNeverLogged = (lines) => { for (const line of lines) assert.ok(!line.includes(KEY), `the key was logged: ${line}`); };

test('shots go to Supabase as rows and the bag comes back from the bag_shots view', async () => {
  const dir = tmpDir();
  const sb = fakeSupabase();
  const { log, lines } = recorder();
  const store = openStore(dir, sb, { log });
  assert.equal(store.kind, 'supabase');
  assert.deepEqual(await store.load(), []);

  await store.append('I7', launch(111), { at: T0, course: 'Lineup Links', hole: 7, lie: 'fairway' });
  await store.append('DR', launch(150, { vla: 12, totalSpin: 2600, hla: 1.5 }), { at: T0 + 60_000, lie: 'tee', clubName: 'DRIVER' });
  await store.append('PT', launch(8), { at: T0 + 90_000 });   // not a full club: never stored
  assert.equal(await store.sync(), true);
  assert.equal(store.pending, 0);
  assert.deepEqual(readJson(path.join(dir, 'bag-outbox.json')), { version: 1, rows: [] });

  const i7 = sb.tables.shots.get(rowId(['default', 'I7', T0, 111, 19, 0, 7000, 0]));
  assert.deepEqual(i7, {
    id: rowId(['default', 'I7', T0, 111, 19, 0, 7000, 0]), player: 'default', club: 'I7',
    speed_mph: 111, vla: 19, hla: 0, total_spin: 7000, spin_axis: 0, at: '2026-11-03T15:00:00.000Z',
    course: 'Lineup Links', hole: 7, lie: 'fairway', practice: null, club_name: null,
  });
  assert.equal(sb.tables.shots.size, 2);

  // the same bag from Supabase on another computer, and kept in its bag.json
  const other = tmpDir();
  const elsewhere = openStore(other, sb, { log });
  const shots = await elsewhere.load();
  assert.deepEqual(shots, [
    { club: 'I7', speedMph: 111, vla: 19, hla: 0, totalSpin: 7000, spinAxis: 0, at: T0, course: 'Lineup Links', lie: 'fairway', hole: 7 },
    { club: 'DR', speedMph: 150, vla: 12, hla: 1.5, totalSpin: 2600, spinAxis: 0, at: T0 + 60_000, lie: 'tee', clubName: 'DRIVER' },
  ]);
  assert.deepEqual(readJson(path.join(other, 'bag.json')).shots, shots);
  assert.ok(sb.writes().length && sb.writes().every((w) => w === 'POST /rest/v1/shots'), 'inserts only');
  assertKeyNeverLogged(lines);
});

test('with Supabase out of reach the game keeps recording, and catches up later', async () => {
  const dir = tmpDir();
  const sb = fakeSupabase();
  const { log, lines } = recorder();
  sb.down = true;
  const store = openStore(dir, sb, { log });
  const bag = new Bag({ store, log });
  await bag.load();
  for (let k = 0; k < 3; k++) assert.equal(bag.record('I8', launch(100 + k), { at: T0 + k }).recorded, true);
  await bag.flush();
  assert.equal(await store.sync(), false);
  assert.equal(bag.total, 3);
  assert.equal(sb.tables.shots.size, 0);
  assert.equal(readJson(path.join(dir, 'bag.json')).shots.length, 3, 'the copy on this computer');
  assert.equal(readJson(path.join(dir, 'bag-outbox.json')).rows.length, 3, 'waiting to be sent');
  assert.equal(lines.filter((l) => l.includes('cannot reach Supabase (ENOTFOUND)')).length, 1, 'said once, not per shot');

  // a restart while still offline: the bag comes from bag.json
  const again = new Bag({ store: openStore(dir, sb, { log }), log });
  await again.load();
  assert.deepEqual(again.shots('I8').map((s) => s.speedMph), [100, 101, 102]);

  // back online: the waiting shots go, and the bag reads from Supabase again
  sb.down = false;
  assert.equal(await again.store.sync(), true);
  assert.equal(sb.tables.shots.size, 3);
  assert.equal(again.store.pending, 0);
  assert.ok(lines.some((l) => l.includes('reachable again')));
  const fresh = new Bag({ store: openStore(tmpDir(), sb, { log }), log });
  await fresh.load();
  assert.deepEqual(fresh.shots('I8'), again.shots('I8'));
  assertKeyNeverLogged(lines);
});

test('a failed send is retried on its own, with a backoff', async () => {
  const sb = fakeSupabase();
  const { log } = recorder();
  sb.down = true;
  const store = openStore(tmpDir(), sb, { log, retryMs: 5 });
  try {
    await store.append('PW', launch(92), { at: T0 });
    assert.equal(await store.sync(), false);
    sb.down = false;
    for (let waited = 0; sb.tables.shots.size === 0 && waited < 2000; waited += 10) await new Promise((r) => setTimeout(r, 10));
    assert.equal(sb.tables.shots.size, 1, 'sent without another shot or a restart');
    assert.equal(store.pending, 0);
  } finally {
    store.close();
  }
});

test('a reset is a marker row: the bag empties, the history stays, nothing is deleted', async () => {
  const sb = fakeSupabase();
  const { log } = recorder();
  let now = T0;
  const store = openStore(tmpDir(), sb, { log });
  const bag = new Bag({ store, log, now: () => now });
  await bag.load();
  bag.record('I7', launch(110));
  now += 1000;
  bag.record('I7', launch(111));
  now += 1000;
  await bag.reset();
  now += 1000;
  bag.record('I7', launch(112));
  await bag.flush();
  await store.sync();
  assert.equal(sb.tables.shots.size, 3, 'every shot stays in the history');
  assert.deepEqual([...sb.tables.bag_resets.values()].map((r) => [r.player, r.at]), [['default', new Date(T0 + 2000).toISOString()]]);
  assert.deepEqual((await store.load()).map((s) => s.speedMph), [112], 'the bag is what came after');

  // offline: a shot, a reset, a shot; once back, Supabase agrees with this computer
  sb.down = true;
  now += 1000;
  bag.record('I7', launch(113));
  now += 1000;
  await bag.reset();
  now += 1000;
  bag.record('I7', launch(114));
  await bag.flush();
  assert.deepEqual(bag.shots('I7').map((s) => s.speedMph), [114]);
  assert.deepEqual((await store.load()).map((s) => s.speedMph), [114], 'offline: the copy on this computer');
  sb.down = false;
  assert.deepEqual((await store.load()).map((s) => s.speedMph), [114], 'online: the same bag from Supabase');
  assert.equal(sb.tables.shots.size, 5);
  assert.equal(sb.tables.bag_resets.size, 2);
  assert.ok(sb.requests.every((r) => r.method === 'GET' || r.method === 'POST'), 'never an update or a delete');
});

test('a shot sent twice is stored once (an answer lost on the way, or the outbox lost)', async () => {
  const dir = tmpDir();
  const sb = fakeSupabase();
  const { log } = recorder();
  const store = openStore(dir, sb, { log });
  await store.load();
  sb.down = true;
  await store.append('W3', launch(140, { vla: 11, totalSpin: 3500 }), { at: T0 });
  assert.equal(await store.sync(), false);
  sb.down = false;
  sb.loseAnswers = 1;   // Supabase stores the shot but the answer never arrives
  assert.equal(await store.sync(), false);
  assert.equal(sb.tables.shots.size, 1);
  assert.equal(store.pending, 1, 'still waiting: this computer cannot know it arrived');
  assert.equal(await store.sync(), true);
  assert.equal(sb.tables.shots.size, 1);
  assert.equal(store.pending, 0);

  // without an outbox the bag in bag.json is queued again: still one row
  fs.rmSync(path.join(dir, 'bag-outbox.json'));
  const again = openStore(dir, sb, { log });
  assert.equal((await again.load()).length, 1);
  assert.equal(sb.tables.shots.size, 1);
});

test('a bag kept in bag.json before Supabase was set up goes to Supabase once', async () => {
  const dir = tmpDir();
  const local = createFileStore(path.join(dir, 'bag.json'));
  for (let k = 0; k < 3; k++) await local.append('I6', launch(120 + k), { at: T0 + k, course: 'Lineup Links' });
  fs.writeFileSync(path.join(dir, 'supabase.json'), JSON.stringify({ url: PROJECT, key: KEY }));
  const sb = fakeSupabase();
  const { log, lines } = recorder();
  const store = createStore({ dataDir: dir, log, fetchImpl: sb.fetch });
  try {
    assert.equal(store.kind, 'supabase');
    assert.equal((await store.load()).length, 3);
    assert.equal(sb.tables.shots.size, 3);
    const posts = sb.writes().length;
    const restarted = createStore({ dataDir: dir, log, fetchImpl: sb.fetch });
    assert.equal((await restarted.load()).length, 3);
    assert.equal(sb.writes().length, posts, 'nothing sent again after a restart');
    restarted.close();
  } finally {
    store.close();
  }
  assertKeyNeverLogged(lines);
});

test('a row the database refuses is dropped with a warning; the rest still go, a server error keeps them', async () => {
  const sb = fakeSupabase({
    refuse: (table, row) => (table === 'shots' && row.club === 'LW'
      ? { code: '23514', message: 'new row for relation "shots" violates check constraint "shots_angles"' } : null),
  });
  const { log, lines } = recorder();
  const store = openStore(tmpDir(), sb, { log });
  sb.down = true;
  await store.append('I9', launch(98), { at: T0 });
  await store.append('LW', launch(70, { vla: 32 }), { at: T0 + 1 });
  await store.append('PW', launch(91), { at: T0 + 2 });
  assert.equal(await store.sync(), false);
  sb.down = false;
  sb.status = 503;   // Supabase busy: everything waits
  assert.equal(await store.sync(), false);
  assert.equal(store.pending, 3);
  sb.status = null;
  assert.equal(await store.sync(), true);
  assert.deepEqual([...sb.tables.shots.values()].map((r) => r.club).sort(), ['I9', 'PW']);
  assert.equal(store.pending, 0);
  assert.ok(lines.some((l) => /refused a LW shot .*shots_angles/.test(l)), lines.join('\n'));
});

test('supabase.json: the store is chosen only for a usable file with the publishable key', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'supabase.json');
  const { log, lines } = recorder();
  const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

  assert.equal(readSupabaseConfig(file, log), null, 'no file: the bag stays in bag.json');
  assert.equal(lines.length, 0);
  assert.equal(createStore({ dataDir: dir, log }).kind, 'file');

  write({ url: `${PROJECT}/rest/v1/`, key: ` ${KEY} ` });
  assert.deepEqual(readSupabaseConfig(file, log), { url: PROJECT, key: KEY, player: 'default' });
  write({ url: PROJECT, key: KEY, player: 'jordan' });
  assert.equal(readSupabaseConfig(file, log).player, 'jordan');
  const bag = new Bag({ store: createStore({ dataDir: dir, log, fetchImpl: fakeSupabase().fetch }), log });
  assert.equal(bag.summary().store, 'supabase');
  bag.store.close();

  const refused = [
    { url: PROJECT, key: 'sb_secret_abc123' },                          // bypasses every policy
    { url: PROJECT, key: jwt({ role: 'service_role' }) },               // a legacy secret key
    { url: PROJECT, key: KEY, player: 'two words' },
    { url: 'ftp://example.com', key: KEY },
    { url: PROJECT },
  ];
  for (const config of refused) {
    write(config);
    assert.equal(readSupabaseConfig(file, log), null, JSON.stringify(config));
  }
  assert.ok(lines.some((l) => l.includes('secret key')));
  write({ url: PROJECT, key: jwt({ role: 'anon' }) });
  assert.ok(readSupabaseConfig(file, log), 'a legacy anon key is a publishable key');
  assert.equal(isSecretKey(KEY), false);

  write(`{"url": "${PROJECT}", "key": ${KEY}}`);   // the key unquoted: not JSON
  assert.equal(readSupabaseConfig(file, log), null);
  assert.ok(lines.at(-1).includes('not valid JSON'));
  assertKeyNeverLogged(lines);
});
