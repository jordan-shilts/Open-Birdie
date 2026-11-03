'use strict';
// Players and leagues. The roster is everyone who plays on this simulator (a name and
// a handicap index); a league is some of them playing a season of weeks, a course for
// each week, scored gross or net. Rounds are played one player at a time, the way a
// home-simulator league runs: each member gets a card in during the week, and the
// first round a player finishes for a week is the one that counts. Each week pays
// points by finishing position (ties share them), and the season standings add them
// up. Kept in DATA_DIR/leagues.json, written whole (temp file + rename) like the bag.

const fs = require('fs');
const path = require('path');

// Points for 1st, 2nd, ... in a week; everyone further down who posted a card gets 1.
const WEEK_POINTS = Object.freeze([10, 8, 6, 5, 4, 3, 2]);
const SCORING = Object.freeze(['net', 'gross']);
const MAX_NAME = 40;

class LeagueError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const r1 = (v) => Math.round(v * 10) / 10;

// A handicap index as the league uses it: -10 (plus 10) .. 54, one decimal; 0 if unset.
function cleanHandicap(v) {
  const n = typeof v === 'string' && v.trim().startsWith('+') ? -Number(v.trim().slice(1)) : Number(v);
  return finite(n) ? r1(Math.min(54, Math.max(-10, n))) : 0;
}

// Strokes a player gets over a round of `holes` holes: the index scaled to the round
// (no course rating or slope in open data), rounded like a playing handicap.
function courseHandicap(index, holes = 18) {
  return Math.round((finite(index) ? index : 0) * (holes / 18));
}

// The initials the HUD avatar shows: "Jordan Shilts" -> "JS", "Ana" -> "AN".
function initials(name) {
  const words = cleanName(name).split(' ').filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase();
}

// A week's leaderboard: the posted cards ranked by the league's score (net or gross;
// to par, so courses of any par compare), points by position, ties sharing the points
// of the places they span.
function weekBoard(league, week) {
  const key = league.scoring === 'gross' ? 'toPar' : 'netToPar';
  const cards = league.rounds.filter((r) => r.week === week).sort((a, b) => a[key] - b[key] || a.at - b.at);
  const rows = [];
  for (let i = 0; i < cards.length;) {
    let j = i;
    while (j + 1 < cards.length && cards[j + 1][key] === cards[i][key]) j++;
    let pts = 0;
    for (let k = i; k <= j; k++) pts += WEEK_POINTS[k] ?? 1;
    pts = Math.round((pts / (j - i + 1)) * 2) / 2;
    for (let k = i; k <= j; k++) rows.push({ ...cards[k], rank: i + 1, tied: j > i, points: pts });
    i = j + 1;
  }
  return rows;
}

// Season standings: points summed over the weeks, then rounds played, average score
// to par (the league's scoring), best round and weeks won.
function standings(league, players = []) {
  const name = new Map(players.map((p) => [p.id, p.name]));
  const by = new Map(league.playerIds.map((id) => [id, { playerId: id, name: name.get(id) || '?', points: 0, rounds: 0, sum: 0, best: null, wins: 0 }]));
  const key = league.scoring === 'gross' ? 'toPar' : 'netToPar';
  for (const w of league.weeks) {
    for (const row of weekBoard(league, w.n)) {
      if (!by.has(row.playerId)) by.set(row.playerId, { playerId: row.playerId, name: row.playerName, points: 0, rounds: 0, sum: 0, best: null, wins: 0 });
      const s = by.get(row.playerId);
      s.points += row.points;
      s.rounds++;
      s.sum += row[key];
      if (s.best == null || row[key] < s.best) s.best = row[key];
      if (row.rank === 1) s.wins++;
    }
  }
  const rows = [...by.values()].map(({ sum, ...s }) => ({ ...s, avg: s.rounds ? r1(sum / s.rounds) : null }));
  rows.sort((a, b) => b.points - a.points || (a.avg ?? 1e9) - (b.avg ?? 1e9) || a.name.localeCompare(b.name));
  let rank = 0;
  rows.forEach((row, i) => { if (i === 0 || row.points !== rows[i - 1].points) rank = i + 1; row.rank = rank; });
  return rows;
}

// A finished round as the league keeps it, from the round's card.
//   card: { course, pars: [..], scores: [..], pickedUp: [..] } (lib/game.js state)
function roundCard(card, { week, player, at = Date.now() }) {
  const holes = card.scores.length;
  const par = card.pars.reduce((a, b) => a + b, 0);
  const gross = card.scores.reduce((a, b) => a + (b || 0), 0);
  const handicap = courseHandicap(player.handicap, holes);
  return {
    id: newId('r_'), week, playerId: player.id, playerName: player.name, at,
    course: card.course, holes, par, gross, toPar: gross - par,
    handicap, net: gross - handicap, netToPar: gross - handicap - par,
    pickedUp: (card.pickedUp || []).filter(Boolean).length,
    scores: card.scores.slice(),
  };
}

function cleanCourse(c) {
  if (!c || typeof c !== 'object') return null;
  const name = cleanName(c.name ?? '').slice(0, 160) || null;
  const out = { name };
  if (typeof c.cached === 'string' && /^[\w.-]+\.json$/.test(c.cached)) out.cached = c.cached;
  if (typeof c.courseId === 'string') out.courseId = c.courseId.slice(0, 120);
  return out.cached || out.courseId ? out : null;
}

function createLeagues({ dataDir, file = path.join(dataDir, 'leagues.json'), log = console } = {}) {
  let data = null;
  const read = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`[leagues] cannot read ${path.basename(file)}: ${err.message}`);
      return { version: 1, players: [], activePlayerId: null, leagues: [] };
    }
    try {
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.players) || !Array.isArray(d.leagues)) throw new Error('not a leagues file');
      return { version: 1, players: d.players, activePlayerId: d.activePlayerId ?? null, leagues: d.leagues };
    } catch (err) {
      log.warn(`[leagues] ignoring ${path.basename(file)}: ${err.message}`);
      try { fs.renameSync(file, `${file}.corrupt`); } catch (_) { /* leave it */ }
      return { version: 1, players: [], activePlayerId: null, leagues: [] };
    }
  };
  const d = () => { if (!data) data = read(); return data; };
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const player = (id) => d().players.find((p) => p.id === id) || null;
  const league = (id) => {
    const l = d().leagues.find((x) => x.id === id);
    if (!l) throw new LeagueError('No such league', 404);
    return l;
  };
  const view = (l) => ({
    ...l,
    standings: standings(l, d().players),
    weekBoards: Object.fromEntries(l.weeks.map((w) => [w.n, weekBoard(l, w.n)])),
  });

  return {
    file,
    get activePlayer() { return player(d().activePlayerId) || d().players[0] || null; },
    player,
    state() {
      const s = d();
      const active = this.activePlayer;
      return {
        players: s.players.map((p) => ({ ...p, initials: initials(p.name) })),
        activePlayerId: active ? active.id : null,
        leagues: s.leagues.map(view),
      };
    },

    addPlayer({ name, handicap } = {}) {
      const n = cleanName(name);
      if (!n) throw new LeagueError('A player needs a name');
      if (d().players.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new LeagueError(`${n} is already on the roster`);
      const p = { id: newId('p_'), name: n, handicap: cleanHandicap(handicap) };
      d().players.push(p);
      if (!d().activePlayerId) d().activePlayerId = p.id;
      write();
      return p;
    },
    updatePlayer(id, { name, handicap } = {}) {
      const p = player(id);
      if (!p) throw new LeagueError('No such player', 404);
      if (name !== undefined) {
        const n = cleanName(name);
        if (!n) throw new LeagueError('A player needs a name');
        if (d().players.some((o) => o.id !== id && o.name.toLowerCase() === n.toLowerCase())) throw new LeagueError(`${n} is already on the roster`);
        p.name = n;
      }
      if (handicap !== undefined) p.handicap = cleanHandicap(handicap);
      write();
      return p;
    },
    // A player in a league stays on the roster: their cards would lose their name.
    removePlayer(id) {
      if (!player(id)) throw new LeagueError('No such player', 404);
      const inLeague = d().leagues.find((l) => l.playerIds.includes(id) || l.rounds.some((r) => r.playerId === id));
      if (inLeague) throw new LeagueError(`Plays in ${inLeague.name}: take them out of it first`, 409);
      d().players = d().players.filter((p) => p.id !== id);
      if (d().activePlayerId === id) d().activePlayerId = d().players[0]?.id ?? null;
      write();
      return true;
    },
    setActivePlayer(id) {
      if (!player(id)) throw new LeagueError('No such player', 404);
      d().activePlayerId = id;
      write();
      return player(id);
    },

    // { name, scoring: 'net'|'gross', playerIds, weeks: [{ course: {cached, name, courseId} }] }
    createLeague({ name, scoring = 'net', playerIds = [], weeks = [] } = {}) {
      const n = cleanName(name);
      if (!n) throw new LeagueError('A league needs a name');
      const ids = [...new Set(playerIds)].filter((id) => player(id));
      if (ids.length < 1) throw new LeagueError('Pick at least one player');
      const ws = weeks.map((w) => cleanCourse(w && w.course)).filter(Boolean).map((course, i) => ({ n: i + 1, course }));
      if (!ws.length) throw new LeagueError('Give the league at least one week with a course');
      const l = {
        id: newId('l_'), name: n, scoring: SCORING.includes(scoring) ? scoring : 'net',
        createdAt: Date.now(), playerIds: ids, weeks: ws, currentWeek: 1, rounds: [],
      };
      d().leagues.push(l);
      write();
      return view(l);
    },
    // rename, rescore, add or drop members (not one with cards), add a week, move the
    // current week
    updateLeague(id, { name, scoring, playerIds, addWeek, currentWeek } = {}) {
      const l = league(id);
      if (name !== undefined) {
        const n = cleanName(name);
        if (!n) throw new LeagueError('A league needs a name');
        l.name = n;
      }
      if (scoring !== undefined && SCORING.includes(scoring)) l.scoring = scoring;
      if (Array.isArray(playerIds)) {
        const ids = [...new Set(playerIds)].filter((pid) => player(pid));
        const dropped = l.playerIds.filter((pid) => !ids.includes(pid) && l.rounds.some((r) => r.playerId === pid));
        if (dropped.length) throw new LeagueError(`${player(dropped[0])?.name || 'A player'} has cards in this league and stays in it`, 409);
        if (!ids.length) throw new LeagueError('A league needs at least one player');
        l.playerIds = ids;
      }
      if (addWeek) {
        const course = cleanCourse(addWeek.course);
        if (!course) throw new LeagueError('A week needs a course');
        l.weeks.push({ n: l.weeks.length + 1, course });
      }
      if (currentWeek !== undefined) {
        const n = Number(currentWeek);
        if (!l.weeks.some((w) => w.n === n)) throw new LeagueError('No such week');
        l.currentWeek = n;
      }
      write();
      return view(l);
    },
    removeLeague(id) {
      league(id);
      d().leagues = d().leagues.filter((l) => l.id !== id);
      write();
      return true;
    },

    // The week a player is about to play: its course, or why they can't.
    weekToPlay(leagueId, week, playerId) {
      const l = league(leagueId);
      const w = l.weeks.find((x) => x.n === Number(week));
      if (!w) throw new LeagueError('No such week');
      if (!l.playerIds.includes(playerId)) throw new LeagueError('That player is not in this league');
      if (l.rounds.some((r) => r.week === w.n && r.playerId === playerId)) {
        throw new LeagueError(`${player(playerId)?.name || 'That player'} already has a card for week ${w.n}`, 409);
      }
      return { league: l, week: w };
    },

    // Post a finished round. The first card a player finishes for a week counts; a
    // second is refused (posted: false). Returns the card and its place this week.
    postRound(leagueId, week, playerId, card, at = Date.now()) {
      const l = league(leagueId);
      const p = player(playerId);
      if (!p) throw new LeagueError('No such player', 404);
      if (l.rounds.some((r) => r.week === week && r.playerId === playerId)) return { posted: false, reason: 'already' };
      const round = roundCard(card, { week, player: p, at });
      l.rounds.push(round);
      write();
      const row = weekBoard(l, week).find((x) => x.id === round.id);
      return { posted: true, round, rank: row.rank, tied: row.tied, of: weekBoard(l, week).length, league: l.name };
    },
  };
}

module.exports = { createLeagues, LeagueError, WEEK_POINTS, courseHandicap, initials, standings, weekBoard, roundCard, cleanHandicap };
