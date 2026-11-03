// Players and leagues in the HUD.
//  - The round card is the player switcher: who is playing, add a player, manage them.
//  - While a league round is on, a chip under the player's name keeps its score live
//    ("wk 2 · net +1 thru 7").
//  - The League screen is the clubhouse: the season's weeks across the top, the
//    standings (movement since last week, form week by week) beside the week's board
//    (the cards in, the round being played, and a Play tile for everyone still to play).
//    New leagues are set up in four steps; players get their own screen.
//  - A posted card gets its moment: score, place this week, points, standing.
// The server owns all of it (lib/leagues.js): every change is POSTed and the new state
// comes back on the 'leagues' stream, so the screens just re-render.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (name) => String(name || '').split(',')[0];
const pts = (v) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));
const toPar = (v) => (v == null ? '–' : v === 0 ? 'E' : v > 0 ? `+${v}` : `−${Math.abs(v)}`);
const parClass = (v) => (v == null ? '' : v < 0 ? 'under' : v > 0 ? 'over' : 'even');
const ordinal = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const hcpText = (h) => (!h ? '–' : h < 0 ? `+${-h}` : `${h}`);
// strokes over `holes` holes, as lib/leagues.js courseHandicap gives them
const strokesFor = (index, holes) => Math.round((index || 0) * (holes / 18));
const POINTS_RULE = 'Each week pays 10 · 8 · 6 · 5 · 4 · 3 · 2 points for 1st to 7th and 1 for every other card; ties share. A player\'s first finished card of the week is the one that counts.';
const NAME_IDEAS = ['Tuesday Night League', 'Winter Indoor League', 'Family Cup', 'Weekend Warriors'];
const STEPS = ['Basics', 'Players', 'Schedule', 'Review'];

// Each player keeps one colour everywhere (avatar, round card), picked from their id.
const PALETTE = ['#45d483', '#5ab8ff', '#ff8a5c', '#c792ff', '#ff6fa8', '#3fd1c6', '#f5b53d', '#9ad64a'];
export function playerColor(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase();
}
const avatar = (id, name, size = '') => `<span class="lgx-av ${size}" style="--c:${playerColor(id)}" aria-hidden="true">${esc(initialsOf(name))}</span>`;
const trophy = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5h8v5a4 4 0 0 1-8 0z"/><path d="M8 6.5H4.5a3 3 0 0 0 3.6 3.4M16 6.5h3.5a3 3 0 0 1-3.6 3.4"/><path d="M12 13.5V17M8.5 19.5h7M10 17h4"/></svg>';
const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>';
const people = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>';

async function post(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}

export class LeaguesUI {
  // toast(main, sub): a HUD message; clearStage(): close the other panels in the middle
  // of the screen (the scorecard, the games menu) when this one opens or a round starts
  constructor({ toast = () => {}, clearStage = () => {} } = {}) {
    this.toast = toast;
    this.clearStage = clearStage;
    this.data = { players: [], activePlayerId: null, leagues: [] };
    this.game = null;           // the round state (courseName, player, leagueRound, scores)
    this.courses = [];          // downloaded courses, for schedules
    this.view = null;           // welcome | list | club | create | players | manage (null: pick)
    this.leagueId = null;
    this.week = null;           // the week the clubhouse shows (null: the current one)
    this.draft = null;          // the new-league steps
    this.back = null;           // where the players screen returns to
    this.error = '';
    this.result = null;         // the card just posted, for its moment
    this._live = '';            // the live round as last drawn (re-render only on change)
    this.panel = $('league-panel');
    this.body = $('lg-body');
    this.panel.addEventListener('click', (e) => this._click(e));
    this.panel.addEventListener('input', (e) => this._input(e));
    this.panel.addEventListener('change', (e) => this._change(e));
    this.panel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); this._enter(e.target); } });
    this.panel.addEventListener('focusout', () => setTimeout(() => { if (this._stale && !this._typing()) this.render(); }, 0));
    for (const id of ['player-avatar', 'player-name']) {
      const el = $(id);
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.title = 'Switch player';
      el.onclick = (e) => { e.stopPropagation(); this.togglePlayerMenu(); };
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.togglePlayerMenu(); } };
    }
    $('player-menu').addEventListener('click', (e) => this._menuClick(e));
    $('player-menu').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pm-new-name') { e.preventDefault(); this._menuAdd(); } });
    document.addEventListener('click', (e) => {
      if (!$('player-menu').contains(e.target)) $('player-menu').classList.add('hidden');
    });
    $('league-chip').onclick = () => { const lr = this.game?.leagueRound; this.open('club', lr?.leagueId, lr?.week); };
    $('lg-result').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lgr]');
      if (!b && e.target !== $('lg-result')) return;
      const r = this.result;
      this.closeResult();
      if (b && b.dataset.lgr === 'standings' && r) this.open('club', r.leagueId, r.week);
    });
    this.refresh();
  }

  async refresh() {
    try { this.setData(await (await fetch('/api/leagues')).json()); } catch (_) { /* server starting */ }
  }

  // ---------- data in ----------
  setData(d) {
    if (!d || !Array.isArray(d.players)) return;
    this.data = { players: d.players, activePlayerId: d.activePlayerId, leagues: d.leagues || [] };
    if (this.leagueId && !this.league) { this.leagueId = null; if (['club', 'manage'].includes(this.view)) this.view = null; }
    if (this.result) this._drawResult();
    this.render();
  }

  setGameState(s) {
    this.game = s;
    const pl = s && s.player;
    $('player-avatar').style.background = pl ? playerColor(pl.id) : '';
    const live = this.liveRound();
    const chip = $('league-chip');
    chip.classList.toggle('hidden', !live);
    if (live) {
      const score = live.thru ? `${live.scoring === 'gross' ? '' : 'net '}${toPar(live.now)} thru ${live.thru}` : 'first tee';
      chip.innerHTML = `<span>LEAGUE · WK ${live.week}</span> <em class="${parClass(live.thru ? live.now : null)}">${esc(score)}</em>`;
      chip.title = `${live.leagueName}, week ${live.week}: open the league`;
    }
    const key = JSON.stringify(live);
    if (key !== this._live) { this._live = key; if (this.view === 'club' || this.view === null) this.render(); }
  }

  get league() { return this.data.leagues.find((l) => l.id === this.leagueId) || null; }
  player(id) { return this.data.players.find((p) => p.id === id) || null; }
  playerName(id) { return this.player(id)?.name || '?'; }

  // The league round being played, as it stands: holes done, score to par (net with the
  // handicap's strokes for the holes played), and the place that pace would take among
  // this week's cards.
  liveRound() {
    const s = this.game;
    const lr = s && s.leagueRound;
    if (!lr) return null;
    const scores = s.scores || [], pars = s.pars || [];
    let thru = 0, gross = 0, par = 0;
    scores.forEach((sc, i) => { if (sc != null) { thru++; gross += sc; par += pars[i]; } });
    const league = this.data.leagues.find((l) => l.id === lr.leagueId);
    const scoring = league ? league.scoring : 'net';
    const toParG = gross - par;
    const toParN = toParG - strokesFor(s.player?.handicap, thru);
    const now = scoring === 'gross' ? toParG : toParN;
    const board = (league && league.weekBoards[lr.week]) || [];
    let pace = null;
    if (thru >= 3 && thru < pars.length) {
      const key = scoring === 'gross' ? 'toPar' : 'netToPar';
      const projected = Math.round((now * pars.length) / thru);
      pace = 1 + board.filter((r) => r[key] < projected).length;
    }
    return { ...lr, thru, hole: s.hole, now, scoring, pace, of: board.length + 1 };
  }

  // ---------- open / close ----------
  toggle(force) {
    const show = force ?? this.panel.classList.contains('hidden');
    this.panel.classList.toggle('hidden', !show);
    $('btn-league').classList.toggle('active', show);
    if (show) {
      this.clearStage();
      this.error = '';
      this.render();
      this.panel.focus({ preventScroll: true });
    }
  }

  open(view = null, leagueId = null, week = null) {
    this.view = view;
    if (leagueId) { this.leagueId = leagueId; this.week = week; }
    if (view === 'create') this._startDraft();
    this.toggle(true);
  }

  // Where the League button lands: the league being played, else the only league,
  // else the list of leagues, else the welcome.
  _route() {
    if (this.view && this.view !== 'club') return this.view;
    if (this.view === 'club' && this.league) return 'club';
    const lr = this.game && this.game.leagueRound;
    if (lr && this.data.leagues.some((l) => l.id === lr.leagueId)) { this.leagueId = lr.leagueId; return 'club'; }
    if (this.data.leagues.length === 1) { this.leagueId = this.data.leagues[0].id; return 'club'; }
    if (this.leagueId && this.league) return 'club';
    return this.data.leagues.length ? 'list' : 'welcome';
  }

  _typing() {
    const a = document.activeElement;
    return !!(a && this.panel.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  // ---------- rendering ----------
  render() {
    if (this.panel.classList.contains('hidden')) return;
    if (this._typing()) { this._stale = true; return; }   // never wipe what's being typed
    this._stale = false;
    const view = this._route();
    this.view = view;
    const l = this.league;
    const head = {
      welcome: ['LEAGUES', 'Leagues', ''],
      list: ['LEAGUES', 'Your leagues', ''],
      club: ['LEAGUE', l?.name, l ? this._seasonMeta(l) : ''],
      create: ['NEW LEAGUE', this.draft?.name?.trim() || 'Set up a league', ''],
      players: ['PLAYERS', 'Who plays here', ''],
      manage: ['MANAGE LEAGUE', l?.name, ''],
    }[view];
    $('lg-eyebrow').textContent = head[0];
    $('lg-title').textContent = head[1] || '';
    $('lg-headmeta').innerHTML = head[2];
    const err = this.error ? `<div class="lgx-error" role="alert">${esc(this.error)}</div>` : '';
    const body = view === 'club' ? this._club(l) : view === 'create' ? this._create() : view === 'players' ? this._players()
      : view === 'manage' ? this._manage(l) : view === 'list' ? this._list() : this._welcome();
    this.body.innerHTML = err + body;
  }

  _seasonMeta(l) {
    return `<span class="lgx-pill">${l.scoring === 'gross' ? 'GROSS' : 'NET'}</span>
      <span class="lgx-headstat"><b>${l.currentWeek}<small>/${l.weeks.length}</small></b><span>WEEK</span></span>
      <span class="lgx-headstat"><b>${l.playerIds.length}</b><span>PLAYERS</span></span>
      <span class="lgx-headstat"><b>${l.rounds.length}</b><span>CARDS IN</span></span>`;
  }

  _welcome() {
    const ps = this.data.players;
    const crowd = ps.length
      ? `<div class="lgx-crowd">${ps.slice(0, 8).map((p) => avatar(p.id, p.name, 'md')).join('')}<span>${ps.length} player${ps.length === 1 ? '' : 's'} on the roster</span></div>`
      : '';
    return `<div class="lgx-hero">
      <div class="lgx-hero-mark">${trophy}</div>
      <h2>Run a league on your simulator</h2>
      <p>Everyone gets their round in during the week, on the same course. Places pay points, and the standings run all season.</p>
      <ol class="lgx-how">
        <li><b>1</b><span><strong>Add players</strong>With a handicap if you like: net scoring levels the field.</span></li>
        <li><b>2</b><span><strong>Pick a course for each week</strong>From the courses you've downloaded.</span></li>
        <li><b>3</b><span><strong>Play your card</strong>Tap Play, finish the round, and it posts itself.</span></li>
      </ol>
      ${crowd}
      <div class="lgx-actions center"><button class="btn primary" data-act="create">Start a league</button><button class="btn" data-act="players">${ps.length ? 'Players' : 'Add players'}</button></div>
    </div>`;
  }

  _list() {
    const cards = this.data.leagues.map((l) => {
      const lead = l.standings.find((s) => s.rounds > 0);
      const w = l.weeks.find((x) => x.n === l.currentWeek) || l.weeks[0];
      const done = (l.weekBoards[w.n] || []).length;
      return `<button class="lgx-lcard" data-open="${esc(l.id)}">
        <span class="lgx-lcard-top"><b>${esc(l.name)}</b><span class="lgx-pill">${l.scoring === 'gross' ? 'GROSS' : 'NET'}</span></span>
        <span class="lgx-lcard-week">Week ${l.currentWeek} of ${l.weeks.length} · ${esc(short(w.course.name))}</span>
        <span class="lgx-meter"><i style="width:${Math.round((100 * done) / Math.max(1, l.playerIds.length))}%"></i></span>
        <span class="lgx-lcard-sub">${done} of ${l.playerIds.length} cards in this week</span>
        <span class="lgx-lcard-lead">${lead ? `${avatar(lead.playerId, lead.name, 'sm')}<span><b>${esc(lead.name)}</b> leads · ${pts(lead.points)} pts</span>` : '<span class="lgx-dim">No cards in yet</span>'}</span>
      </button>`;
    }).join('');
    return `<div class="lgx-lgrid">${cards}<button class="lgx-lcard add" data-act="create"><span class="lgx-plus">+</span><b>New league</b></button></div>
      <div class="lgx-foot"><span></span><span class="lgx-foot-actions"><button class="chip" data-act="players">Players</button></span></div>`;
  }

  // ---------- the clubhouse ----------
  _club(l) {
    const sel = this.week ?? l.currentWeek;
    const weeks = l.weeks.map((w) => {
      const n = (l.weekBoards[w.n] || []).length;
      const full = n >= l.playerIds.length;
      const cls = [w.n === sel ? 'sel' : '', w.n === l.currentWeek ? 'current' : '', full ? 'done' : ''].join(' ');
      return `<button class="lgx-wk ${cls}" data-wk="${w.n}" aria-pressed="${w.n === sel}" title="Week ${w.n}: ${esc(short(w.course.name))}, ${n} of ${l.playerIds.length} cards">
        <span class="lgx-wk-n">${full ? '✓ ' : ''}WEEK ${w.n}${w.n === l.currentWeek ? ' · NOW' : ''}</span>
        <span class="lgx-wk-c">${esc(short(w.course.name))}</span>
        <span class="lgx-meter"><i style="width:${Math.round((100 * n) / Math.max(1, l.playerIds.length))}%"></i></span>
      </button>`;
    }).join('');
    return `<div class="lgx-season" aria-label="Weeks">${weeks}</div>
      <div class="lgx-grid">
        <section class="lgx-card" aria-label="Standings">${this._standings(l)}</section>
        <section class="lgx-card" aria-label="Week ${sel}">${this._week(l, sel)}</section>
      </div>
      <div class="lgx-foot"><span>${esc(POINTS_RULE)}</span>
        <span class="lgx-foot-actions"><button class="chip" data-act="list">All leagues</button><button class="chip" data-act="players">Players</button><button class="chip" data-act="manage">Manage league</button></span></div>`;
  }

  _standings(l) {
    const last = l.rounds.reduce((m, r) => Math.max(m, r.week), 0);
    const live = this.liveRound();
    const rows = l.standings.map((s) => {
      const rank = s.rounds ? s.rank : null;
      const form = (s.form || []).map((f, i) => (f
        ? `<i class="f${f.rank <= 3 ? f.rank : ''}" title="Week ${f.week}: ${f.tied ? 'T' : ''}${ordinal(f.rank)}">${f.tied ? 'T' : ''}${f.rank}</i>`
        : `<i class="f0" title="Week ${i + 1}: no card">–</i>`)).join('');
      const mv = s.move > 0 ? `<span class="lgx-mv up" title="Up ${s.move} since last week">▲${s.move}</span>`
        : s.move < 0 ? `<span class="lgx-mv down" title="Down ${-s.move} since last week">▼${-s.move}</span>` : '';
      const playing = live && live.leagueId === l.id && live.playerId === s.playerId;
      return `<div class="lgx-tr ${rank === 1 && s.points > 0 ? 'lead' : ''} ${playing ? 'playing' : ''}">
        <span class="lgx-rank ${rank && rank <= 3 && s.points > 0 ? `r${rank}` : ''}">${rank ?? '–'}</span>
        <span class="lgx-player">${avatar(s.playerId, s.name)}<span class="lgx-who"><b>${esc(s.name)} ${mv}</b>
          <small>${s.rounds ? `${s.rounds} card${s.rounds === 1 ? '' : 's'} · best ${toPar(s.best)}${s.wins ? ` · ${s.wins} win${s.wins === 1 ? '' : 's'}` : ''}` : playing ? 'playing now' : 'no cards yet'}</small></span></span>
        <span class="lgx-form">${form}</span>
        <span class="lgx-avg ${parClass(s.avg == null ? null : Math.round(s.avg))}">${s.avg == null ? '–' : toPar(s.avg)}</span>
        <span class="lgx-pts"><b>${pts(s.points)}</b></span>
      </div>`;
    }).join('');
    return `<div class="lgx-card-head"><span class="lbl">STANDINGS</span><span class="lgx-note">${last ? `after week ${last}` : 'no cards in yet'} · ${l.scoring === 'gross' ? 'gross' : 'net'} to par</span></div>
      <div class="lgx-table">
        <div class="lgx-th"><span>#</span><span>Player</span><span>Form</span><span>Avg</span><span>Pts</span></div>${rows}
      </div>`;
  }

  _week(l, n) {
    const w = l.weeks.find((x) => x.n === n) || l.weeks[0];
    const board = l.weekBoards[w.n] || [];
    const done = new Set(board.map((r) => r.playerId));
    const live = this.liveRound();
    const liveHere = live && live.leagueId === l.id && live.week === w.n ? live : null;
    const todo = l.playerIds.filter((id) => !done.has(id) && !(liveHere && liveHere.playerId === id));
    const key = l.scoring === 'gross' ? 'toPar' : 'netToPar';
    const here = this.game && this.game.courseName === w.course.name;
    const cards = board.map((r) => `<div class="lgx-crow ${r.rank === 1 ? 'top' : ''}">
        <span class="lgx-rank ${r.rank <= 3 ? `r${r.rank}` : ''}">${r.tied ? 'T' : ''}${r.rank}</span>
        ${avatar(r.playerId, r.playerName)}
        <span class="lgx-who"><b>${esc(r.playerName)}</b><small>Gross ${r.gross} · Net ${r.net}${r.pickedUp ? ` · ${r.pickedUp} picked up` : ''}</small></span>
        <span class="lgx-topar ${parClass(r[key])}">${toPar(r[key])}</span>
        <span class="lgx-earned">+${pts(r.points)}</span>
      </div>`).join('');
    const liveRow = liveHere ? `<div class="lgx-live" aria-live="polite">
        <span class="lgx-pulse" aria-hidden="true"></span>${avatar(liveHere.playerId, liveHere.playerName)}
        <span class="lgx-who"><b>${esc(liveHere.playerName)}</b><small>Playing now · ${liveHere.thru ? `thru ${liveHere.thru}` : 'on the first tee'}</small></span>
        ${liveHere.pace ? `<span class="lgx-pace">on pace for ${ordinal(liveHere.pace)}</span>` : ''}
        <span class="lgx-topar ${parClass(liveHere.thru ? liveHere.now : null)}">${liveHere.thru ? toPar(liveHere.now) : 'E'}</span>
      </div>` : '';
    const play = todo.map((id) => `<button class="lgx-playtile" data-play="${esc(id)}" data-week="${w.n}">
        ${avatar(id, this.playerName(id), 'lg')}<b>${esc(this.playerName(id))}</b><span class="lgx-go">Play ▶</span></button>`).join('');
    const full = !todo.length && !liveHere;
    const winner = board[0];
    return `<div class="lgx-week-head">
        <button class="lgx-nav" data-step="-1" ${w.n <= 1 ? 'disabled' : ''} aria-label="Previous week">‹</button>
        <div><span class="lbl">WEEK ${w.n}${w.n === l.currentWeek ? ' · THIS WEEK' : ''}</span><b>${esc(short(w.course.name))}</b>
          <small>${board.length} of ${l.playerIds.length} cards in${w.n !== l.currentWeek ? ` · <button class="lgx-link" data-current="${w.n}">make this the current week</button>` : ''}</small></div>
        <button class="lgx-nav" data-step="1" ${w.n >= l.weeks.length ? 'disabled' : ''} aria-label="Next week">›</button>
      </div>
      ${liveRow}
      ${cards ? `<div class="lgx-cards">${cards}</div>` : liveRow ? '' : '<div class="lgx-empty">No cards in for this week yet.</div>'}
      ${play ? `<div class="lgx-todo"><span class="lbl">UP NEXT${here ? '' : ` · loads ${esc(short(w.course.name))}`}</span><div class="lgx-todo-grid">${play}</div></div>` : ''}
      ${full && winner ? `<div class="lgx-done">${trophy}<span><b>${esc(winner.playerName)}</b> ${winner.tied ? 'shares' : 'wins'} week ${w.n} · every card is in</span>
        ${w.n === l.currentWeek && w.n < l.weeks.length ? `<button class="chip" data-current="${w.n + 1}">On to week ${w.n + 1}</button>` : ''}</div>` : ''}`;
  }

  // ---------- new league, in four steps ----------
  _startDraft() {
    this.draft = {
      step: 0, name: '', scoring: 'net',
      playerIds: this.data.players.map((p) => p.id),
      weeks: 4, same: true, course: null, perWeek: [],
    };
    this._loadCourses();
  }

  _create() {
    const d = this.draft || (this._startDraft(), this.draft);
    const steps = STEPS.map((s, i) => `<span class="lgx-step ${i === d.step ? 'on' : i < d.step ? 'done' : ''}"><b>${i < d.step ? '✓' : i + 1}</b>${s}</span>`).join('<i class="lgx-step-line"></i>');
    const body = [this._stepBasics, this._stepPlayers, this._stepSchedule, this._stepReview][d.step].call(this, d);
    const last = d.step === STEPS.length - 1;
    return `<div class="lgx-steps">${steps}</div><div class="lgx-stepbody">${body}</div>
      <div class="lgx-wiznav"><button class="btn" data-wiz="${d.step ? 'back' : 'cancel'}">${d.step ? '‹ Back' : 'Cancel'}</button>
        <button class="btn primary" data-wiz="${last ? 'create' : 'next'}">${last ? 'Create league' : 'Next ›'}</button></div>`;
  }

  _stepBasics(d) {
    return `<label class="lgx-field"><span class="lbl">LEAGUE NAME</span>
        <input id="lgx-name" type="text" maxlength="40" placeholder="Name your league" value="${esc(d.name)}" autocomplete="off"></label>
      <div class="lgx-ideas">${NAME_IDEAS.map((n) => `<button class="chip" data-idea="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <span class="lbl lgx-gap">HOW IT'S SCORED</span>
      <div class="lgx-choice" role="radiogroup" aria-label="Scoring">
        <button class="lgx-opt ${d.scoring === 'net' ? 'sel' : ''}" role="radio" aria-checked="${d.scoring === 'net'}" data-scoring="net">
          <b>Net</b><span>Handicaps level the field: every card counts its score minus the player's strokes.</span></button>
        <button class="lgx-opt ${d.scoring === 'gross' ? 'sel' : ''}" role="radio" aria-checked="${d.scoring === 'gross'}" data-scoring="gross">
          <b>Gross</b><span>Lowest score wins, no strokes given. Best when everyone plays to a similar level.</span></button>
      </div>`;
  }

  _stepPlayers(d) {
    const tiles = this.data.players.map((p) => {
      const on = d.playerIds.includes(p.id);
      return `<button class="lgx-ptile ${on ? 'sel' : ''}" data-toggle="${esc(p.id)}" aria-pressed="${on}">
        ${avatar(p.id, p.name, 'lg')}<b>${esc(p.name)}</b><small>HCP ${esc(hcpText(p.handicap))}</small><i class="lgx-tick" aria-hidden="true">✓</i></button>`;
    }).join('');
    return `<p class="lgx-sub">Who's in? Tap a player to add them or leave them out. <b>${d.playerIds.length} selected.</b></p>
      <div class="lgx-pgrid">${tiles}</div>
      ${this._addPlayerRow('Add someone new')}`;
  }

  _stepSchedule(d) {
    const sel = (attr, value) => `<select ${attr}>${this.courses.map((c) => `<option value="${esc(c.file)}" ${c.file === value ? 'selected' : ''}>${esc(short(c.name))}</option>`).join('')}</select>`;
    if (!this.courses.length) return '<p class="lgx-sub">No downloaded courses yet: load a course first (Menu › Change course), then come back.</p>';
    const rows = d.same ? '' : Array.from({ length: d.weeks }, (_, i) => `<div class="lgx-wkrow"><span>Week ${i + 1}</span>${sel(`data-week-course="${i}"`, d.perWeek[i] || d.course)}</div>`).join('');
    return `<div class="lgx-schedtop">
        <div><span class="lbl">WEEKS IN THE SEASON</span><div class="lgx-stepper"><button data-weeks="-1" ${d.weeks <= 1 ? 'disabled' : ''} aria-label="One week fewer">−</button><b>${d.weeks}</b><button data-weeks="1" ${d.weeks >= 20 ? 'disabled' : ''} aria-label="One week more">+</button></div></div>
        <div class="lgx-choice small" role="radiogroup" aria-label="Courses">
          <button class="lgx-opt ${d.same ? 'sel' : ''}" role="radio" aria-checked="${d.same}" data-same="1"><b>One course</b><span>The same course every week.</span></button>
          <button class="lgx-opt ${d.same ? '' : 'sel'}" role="radio" aria-checked="${!d.same}" data-same="0"><b>A course a week</b><span>Pick each week's course.</span></button>
        </div>
      </div>
      ${d.same ? `<label class="lgx-field"><span class="lbl">COURSE</span>${sel('data-week-course="all"', d.course)}</label>` : `<div class="lgx-wklist">${rows}</div>
        ${this.courses.length > 1 ? '<button class="chip" data-act="rotate">Rotate through my courses</button>' : ''}`}`;
  }

  _stepReview(d) {
    const ps = d.playerIds.map((id) => this.player(id)).filter(Boolean);
    const weeks = this._draftWeeks(d);
    return `<div class="lgx-review">
        <div class="lgx-rv-head"><b>${esc(d.name.trim())}</b><span class="lgx-pill">${d.scoring === 'gross' ? 'GROSS' : 'NET'}</span></div>
        <div class="lgx-rv-row"><span class="lbl">${ps.length} PLAYER${ps.length === 1 ? '' : 'S'}</span>
          <div class="lgx-rv-players">${ps.map((p) => `<span>${avatar(p.id, p.name, 'sm')}${esc(p.name)}</span>`).join('')}</div></div>
        <div class="lgx-rv-row"><span class="lbl">${weeks.length} WEEK${weeks.length === 1 ? '' : 'S'}</span>
          <ol class="lgx-rv-weeks">${weeks.map((w) => `<li>${esc(short(w ? w.name : '?'))}</li>`).join('')}</ol></div>
        <p class="lgx-sub">${esc(POINTS_RULE)}</p>
      </div>`;
  }

  _draftWeeks(d) {
    return Array.from({ length: d.weeks }, (_, i) => this.courseFor(d.same ? d.course : (d.perWeek[i] || d.course)));
  }

  _wizNext() {
    const d = this.draft;
    if (d.step === 0 && !d.name.trim()) throw new Error('Give the league a name');
    if (d.step === 1 && !d.playerIds.length) throw new Error('Pick at least one player');
    if (d.step === 2 && !this._draftWeeks(d).every(Boolean)) throw new Error('Every week needs a course');
    d.step = Math.min(STEPS.length - 1, d.step + 1);
  }

  async _createLeague() {
    const d = this.draft;
    const weeks = this._draftWeeks(d).map((course) => ({ course }));
    const { league } = await post('/api/leagues', { name: d.name, scoring: d.scoring, playerIds: d.playerIds, weeks });
    this.draft = null;
    this.leagueId = league.id;
    this.week = null;
    this.view = 'club';
    this.toast(`${league.name} is set up`, `Week 1 is on ${short(league.weeks[0].course.name)}: tap a player to play their card`);
  }

  // ---------- players ----------
  _players() {
    const cards = this.data.leagues.flatMap((l) => l.rounds);
    const cardsBy = (id) => cards.filter((r) => r.playerId === id).length;
    const leaguesBy = (id) => this.data.leagues.filter((l) => l.playerIds.includes(id)).length;
    const rows = this.data.players.map((p) => {
      const active = p.id === this.data.activePlayerId;
      const n = cardsBy(p.id), k = leaguesBy(p.id);
      return `<div class="lgx-pcard ${active ? 'active' : ''}">
        ${avatar(p.id, p.name, 'xl')}
        <input class="lgx-pname" type="text" maxlength="40" value="${esc(p.name)}" data-pname="${esc(p.id)}" aria-label="Name">
        <div class="lgx-hcp"><span class="lbl">HCP</span>
          <button data-hcp-step="-1" data-id="${esc(p.id)}" aria-label="Lower handicap">−</button>
          <input type="text" inputmode="decimal" value="${p.handicap ? hcpText(p.handicap) : ''}" placeholder="0" data-phcp="${esc(p.id)}" aria-label="Handicap index">
          <button data-hcp-step="1" data-id="${esc(p.id)}" aria-label="Raise handicap">+</button></div>
        <small>${n} card${n === 1 ? '' : 's'} · ${k} league${k === 1 ? '' : 's'}</small>
        ${active ? '<span class="lgx-badge">PLAYING NOW</span>' : `<button class="chip" data-active="${esc(p.id)}">Play as ${esc(p.name.split(' ')[0])}</button>`}
        <button class="lgx-del" data-premove="${esc(p.id)}" title="Remove ${esc(p.name)}" aria-label="Remove ${esc(p.name)}">${trash}</button>
      </div>`;
    }).join('');
    return `<p class="lgx-sub">The player marked <b>playing now</b> is who the next shots belong to (switch from your name in the top corner too). A handicap index is optional: 12.4, or +2 for a plus handicap.</p>
      <div class="lgx-pcards">${rows}
        <div class="lgx-pcard add"><span class="lgx-av xl ghost" aria-hidden="true">+</span>
          <input id="lgx-new-name" type="text" maxlength="40" placeholder="Name" autocomplete="off">
          <div class="lgx-hcp"><span class="lbl">HCP</span><input id="lgx-new-hcp" type="text" inputmode="decimal" placeholder="0"></div>
          <button class="btn primary" data-act="add-player">Add player</button></div>
      </div>
      <div class="lgx-foot"><span></span><span class="lgx-foot-actions"><button class="chip" data-act="back">‹ Back</button></span></div>`;
  }

  _addPlayerRow(placeholder) {
    return `<div class="lgx-addrow"><span class="lgx-av ghost" aria-hidden="true">+</span>
      <input id="lgx-new-name" type="text" maxlength="40" placeholder="${esc(placeholder)}" autocomplete="off">
      <input id="lgx-new-hcp" type="text" inputmode="decimal" placeholder="HCP">
      <button class="chip" data-act="add-player">Add</button></div>`;
  }

  // ---------- manage a league ----------
  _manage(l) {
    const members = l.playerIds.map((id) => `<span class="lgx-member">${avatar(id, this.playerName(id), 'sm')}${esc(this.playerName(id))}
      <button data-drop="${esc(id)}" aria-label="Take ${esc(this.playerName(id))} out of the league">×</button></span>`).join('');
    const others = this.data.players.filter((p) => !l.playerIds.includes(p.id));
    const weeks = l.weeks.map((w) => `<div class="lgx-wkrow"><span>Week ${w.n}${w.n === l.currentWeek ? ' <em>NOW</em>' : ''}</span>
      <b>${esc(short(w.course.name))}</b><small>${(l.weekBoards[w.n] || []).length}/${l.playerIds.length} cards</small>
      ${w.n !== l.currentWeek ? `<button class="chip" data-current="${w.n}">Make current</button>` : '<span></span>'}</div>`).join('');
    const sel = `<select id="lgx-add-week">${this.courses.map((c) => `<option value="${esc(c.file)}">${esc(short(c.name))}</option>`).join('')}</select>`;
    return `<label class="lgx-field"><span class="lbl">NAME</span><input type="text" maxlength="40" value="${esc(l.name)}" data-lname="1"></label>
      <span class="lbl lgx-gap">SCORING</span>
      <div class="lgx-choice small" role="radiogroup" aria-label="Scoring">
        <button class="lgx-opt ${l.scoring === 'net' ? 'sel' : ''}" role="radio" aria-checked="${l.scoring === 'net'}" data-lscoring="net"><b>Net</b><span>Handicap strokes off every card.</span></button>
        <button class="lgx-opt ${l.scoring === 'gross' ? 'sel' : ''}" role="radio" aria-checked="${l.scoring === 'gross'}" data-lscoring="gross"><b>Gross</b><span>Lowest score wins.</span></button>
      </div>
      <span class="lbl lgx-gap">PLAYERS</span>
      <div class="lgx-members">${members}${others.length ? `<span class="lgx-addmember"><select id="lgx-member-add">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="chip" data-act="add-member">Add</button></span>` : ''}</div>
      <span class="lbl lgx-gap">SCHEDULE</span>
      <div class="lgx-wklist">${weeks}</div>
      ${this.courses.length ? `<div class="lgx-addrow">${sel}<button class="chip" data-act="add-week">Add a week</button></div>` : ''}
      <div class="lgx-foot"><span><button class="btn danger" data-act="delete">Delete league</button></span>
        <span class="lgx-foot-actions"><button class="chip" data-act="club">‹ Back to the standings</button></span></div>`;
  }

  // ---------- the player switcher ----------
  togglePlayerMenu() {
    const m = $('player-menu');
    const show = m.classList.contains('hidden');
    const ps = this.data.players;
    const lr = this.game && this.game.leagueRound;
    m.innerHTML = `<div class="lgx-pm-head"><span class="lbl">WHO'S PLAYING</span>${lr ? `<small>${esc(lr.playerName)}'s league round is on</small>` : ''}</div>`
      + (ps.length
        ? ps.map((p) => {
          const on = p.id === this.data.activePlayerId;
          return `<button class="menu-item lgx-pm ${on ? 'active' : ''}" data-player="${esc(p.id)}" role="menuitemradio" aria-checked="${on}">
            ${avatar(p.id, p.name)}<span class="lgx-pm-name">${esc(p.name)}</span><em>${p.handicap ? `HCP ${esc(hcpText(p.handicap))}` : ''}</em><i class="lgx-pm-check" aria-hidden="true">${on ? '✓' : ''}</i></button>`;
        }).join('')
        : '<div class="lgx-pm-empty">No players yet: add the first one.</div>')
      + `<div class="lgx-pm-add"><input id="pm-new-name" type="text" maxlength="40" placeholder="Add a player…" autocomplete="off"><button class="chip" data-pm-add="1">Add</button></div>
        <div class="menu-sep"></div>
        <button class="menu-item" data-manage="1">${people}<span>Manage players</span></button>
        <button class="menu-item" data-leagues="1">${trophy}<span>Leagues</span><kbd>L</kbd></button>`;
    m.classList.toggle('hidden', !show);
  }

  async _menuClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pmAdd) { this._menuAdd(); return; }
    $('player-menu').classList.add('hidden');
    if (b.dataset.manage) { this.back = null; this.open('players'); return; }
    if (b.dataset.leagues) { this.open(null); return; }
    if (b.dataset.player && b.dataset.player !== this.data.activePlayerId) {
      try {
        await post('/api/players/active', { id: b.dataset.player });
        this.toast(`${this.playerName(b.dataset.player)} is up`, 'The next shots are theirs');
      } catch (err) { this.toast('Can\'t switch player', err.message); }
    }
  }

  async _menuAdd() {
    const input = $('pm-new-name');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      const { player } = await post('/api/players', { name });
      await post('/api/players/active', { id: player.id }).catch(() => {});
      $('player-menu').classList.add('hidden');
      this.toast(`${player.name} is up`, 'Set their handicap in Manage players');
    } catch (err) { this.toast('Can\'t add player', err.message); }
  }

  // ---------- the card-posted moment ----------
  cardPosted(c) {
    if (!c) return;
    if (!c.posted) {
      if (c.reason === 'already') this.toast('Card not posted', `${c.playerName} already has a card for week ${c.week}`);
      return;
    }
    this.result = { leagueId: c.leagueId, week: c.week, round: c.round, rank: c.rank, tied: c.tied, of: c.of, league: c.league };
    this._drawResult();
    $('lg-result').classList.remove('hidden');
  }

  closeResult() { this.result = null; $('lg-result').classList.add('hidden'); }

  _drawResult() {
    const r = this.result;
    const rd = r.round;
    const l = this.data.leagues.find((x) => x.id === r.leagueId);
    const row = l && (l.weekBoards[r.week] || []).find((x) => x.id === rd.id);
    const st = l && l.standings.find((s) => s.playerId === rd.playerId);
    const net = !l || l.scoring !== 'gross';
    const season = st ? `${ordinal(st.rank)} in the standings${st.move > 0 ? ` <span class="lgx-mv up">▲${st.move}</span>` : st.move < 0 ? ` <span class="lgx-mv down">▼${-st.move}</span>` : ''} · ${pts(st.points)} pts` : '';
    $('lg-result').innerHTML = `<div class="lgr-box" role="dialog" aria-labelledby="lgr-name">
      <span class="lbl">CARD POSTED · ${esc(r.league)} · WEEK ${r.week}</span>
      <div class="lgr-player">${avatar(rd.playerId, rd.playerName, 'xxl')}<b id="lgr-name">${esc(rd.playerName)}</b></div>
      <div class="lgr-scores">
        <div class="${net ? '' : 'main'}"><span class="lbl">GROSS</span><b>${rd.gross}</b><em class="${parClass(rd.toPar)}">${toPar(rd.toPar)}</em></div>
        <div class="${net ? 'main' : ''}"><span class="lbl">NET</span><b>${rd.net}</b><em class="${parClass(rd.netToPar)}">${toPar(rd.netToPar)}</em></div>
      </div>
      <div class="lgr-place"><b>${r.tied ? 'T' : ''}${ordinal(r.rank)}</b> this week<small> of ${r.of} card${r.of === 1 ? '' : 's'} so far</small>${row ? `<span class="lgx-earned big">+${pts(row.points)} pts</span>` : ''}</div>
      ${season ? `<div class="lgr-season">Season: ${season}</div>` : ''}
      <div class="lgx-actions center"><button class="btn primary" data-lgr="standings">See the standings</button><button class="btn" data-lgr="close">Done</button></div>
    </div>`;
  }

  // ---------- actions ----------
  async _do(fn) {
    this.error = '';
    try { await fn(); } catch (err) { this.error = err.message; }
    this.render();
  }

  async _loadCourses() {
    try { this.courses = await (await fetch('/api/courses/cached')).json(); } catch (_) { this.courses = []; }
    const d = this.draft;
    if (d && !d.course) {
      const loaded = this.game && this.game.courseName;
      d.course = (this.courses.find((c) => c.name === loaded) || this.courses[0])?.file || null;
    }
    this.render();
  }

  courseFor(file) {
    const c = this.courses.find((x) => x.file === file);
    return c ? { cached: c.file, name: c.name, courseId: c.courseId } : null;
  }

  _click(e) {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const ds = t.dataset;
    const d = this.draft;
    if (ds.open) { this.leagueId = ds.open; this.week = null; this.view = 'club'; this.error = ''; this.render(); return; }
    if (ds.play) { this._play(ds.play, Number(ds.week)); return; }
    if (ds.wk) { this.week = Number(ds.wk); this.render(); return; }
    if (ds.step) { const l = this.league; this.week = Math.min(l.weeks.length, Math.max(1, (this.week ?? l.currentWeek) + Number(ds.step))); this.render(); return; }
    if (ds.current) { const n = Number(ds.current); this._do(async () => { await post('/api/leagues/update', { id: this.leagueId, currentWeek: n }); this.week = n; }); return; }
    if (ds.idea) { d.name = ds.idea; this.render(); return; }
    if (ds.scoring) { d.scoring = ds.scoring; this.render(); return; }
    if (ds.toggle) {
      d.playerIds = d.playerIds.includes(ds.toggle) ? d.playerIds.filter((id) => id !== ds.toggle) : [...d.playerIds, ds.toggle];
      this.render();
      return;
    }
    if (ds.weeks) { d.weeks = Math.min(20, Math.max(1, d.weeks + Number(ds.weeks))); this.render(); return; }
    if (ds.same) { d.same = ds.same === '1'; this.render(); return; }
    if (ds.wiz) {
      this.error = '';
      if (ds.wiz === 'cancel') { this.draft = null; this.view = null; this.render(); return; }
      if (ds.wiz === 'back') { d.step = Math.max(0, d.step - 1); this.render(); return; }
      if (ds.wiz === 'next') { try { this._wizNext(); } catch (err) { this.error = err.message; } this.render(); return; }
      if (ds.wiz === 'create') { this._do(() => this._createLeague()); return; }
    }
    if (ds.lscoring) { this._do(() => post('/api/leagues/update', { id: this.leagueId, scoring: ds.lscoring })); return; }
    if (ds.drop) { const l = this.league; this._do(() => post('/api/leagues/update', { id: l.id, playerIds: l.playerIds.filter((id) => id !== ds.drop) })); return; }
    if (ds.active) { this._do(() => post('/api/players/active', { id: ds.active })); return; }
    if (ds.hcpStep) {
      const p = this.player(ds.id);
      const next = Math.min(54, Math.max(-10, Math.round((p.handicap || 0) + Number(ds.hcpStep))));
      this._do(() => post('/api/players/update', { id: p.id, handicap: next }));
      return;
    }
    if (ds.premove) {
      const p = this.player(ds.premove);
      if (!window.confirm(`Remove ${p.name} from the roster?`)) return;
      this._do(() => post('/api/players/remove', { id: p.id }));
      return;
    }
    const act = ds.act;
    if (act === 'create') { this.view = 'create'; this._startDraft(); this.error = ''; this.render(); }
    else if (act === 'players') { this.back = this.view; this.view = 'players'; this.error = ''; this.render(); }
    else if (act === 'back') { this.view = this.back && this.back !== 'players' ? this.back : null; this.error = ''; this.render(); }
    else if (act === 'list') { this.view = 'list'; this.leagueId = null; this.render(); }
    else if (act === 'club') { this.view = 'club'; this.render(); }
    else if (act === 'manage') { this.view = 'manage'; if (!this.courses.length) this._loadCourses(); this.render(); }
    else if (act === 'add-player') this._addPlayer();
    else if (act === 'rotate') {
      d.perWeek = Array.from({ length: d.weeks }, (_, i) => this.courses[i % this.courses.length].file);
      this.render();
    } else if (act === 'add-week') {
      const course = this.courseFor($('lgx-add-week').value);
      this._do(() => post('/api/leagues/update', { id: this.leagueId, addWeek: { course } }));
    } else if (act === 'add-member') {
      const l = this.league;
      this._do(() => post('/api/leagues/update', { id: l.id, playerIds: [...l.playerIds, $('lgx-member-add').value] }));
    } else if (act === 'delete') {
      const l = this.league;
      if (!window.confirm(`Delete ${l.name} and all ${l.rounds.length} of its cards? This can't be undone.`)) return;
      this._do(async () => { await post('/api/leagues/remove', { id: l.id }); this.leagueId = null; this.view = null; });
    }
  }

  // typing in the new-league steps only updates the draft (no re-render mid-word)
  _input(e) {
    const t = e.target;
    if (t.id === 'lgx-name' && this.draft) { this.draft.name = t.value; $('lg-title').textContent = t.value.trim() || 'Set up a league'; }
  }

  _change(e) {
    const t = e.target;
    const d = this.draft;
    if (t.dataset.weekCourse !== undefined && d) {
      if (t.dataset.weekCourse === 'all') d.course = t.value;
      else d.perWeek[Number(t.dataset.weekCourse)] = t.value;
    } else if (t.dataset.lname) {
      this._do(() => post('/api/leagues/update', { id: this.leagueId, name: t.value }));
    } else if (t.dataset.pname) {
      this._do(() => post('/api/players/update', { id: t.dataset.pname, name: t.value }));
    } else if (t.dataset.phcp) {
      this._do(() => post('/api/players/update', { id: t.dataset.phcp, handicap: t.value }));
    }
  }

  _enter(input) {
    if (input.id === 'lgx-new-name' || input.id === 'lgx-new-hcp') this._addPlayer();
    else if (input.id === 'lgx-name') { input.blur(); this._click({ target: this.body.querySelector('[data-wiz="next"]') }); }
    else input.blur();   // a name or handicap field: its change event saves it
  }

  _addPlayer() {
    const name = $('lgx-new-name').value, handicap = $('lgx-new-hcp').value;
    if (!name.trim()) { $('lgx-new-name').focus(); return; }
    document.activeElement?.blur();
    this._do(async () => {
      const { player } = await post('/api/players', { name, handicap });
      if (this.draft && !this.draft.playerIds.includes(player.id)) this.draft.playerIds.push(player.id);
    });
  }

  async _play(playerId, week) {
    const l = this.league;
    this.error = '';
    this.body.querySelectorAll('.lgx-playtile').forEach((b) => { b.disabled = true; });
    const tile = this.body.querySelector(`[data-play="${CSS.escape(playerId)}"] .lgx-go`);
    if (tile) tile.textContent = 'Loading…';
    try {
      await post('/api/leagues/play', { leagueId: l.id, week, playerId });
      this.toggle(false);
      this.clearStage();
      this.toast(`${this.playerName(playerId)} is on the tee`, `${l.name}, week ${week}: finish every hole and the card posts itself`);
    } catch (err) {
      this.error = err.message;
      this.render();
    }
  }
}
