// Players and leagues in the HUD: the player switcher on the round card, the league
// chip while a league round is on, and the League panel — the leagues, each with its
// standings, a board per week (the cards in, and Play for whoever hasn't played) and
// its schedule; a new-league form; the roster. The server owns all of it
// (lib/leagues.js): every change is POSTed and the new state comes back on the
// 'leagues' stream, so the panel just re-renders.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toPar = (v) => (v == null ? '–' : v === 0 ? 'E' : v > 0 ? `+${v}` : `−${Math.abs(v)}`);
const short = (name) => String(name || '').split(',')[0];
const pts = (v) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));

async function post(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}

export class LeaguesUI {
  // toast(main, sub): a HUD message; clearStage(): close the other panels in the
  // middle of the screen (the scorecard, the games menu) when this one opens or a
  // league round starts
  constructor({ toast = () => {}, clearStage = () => {} } = {}) {
    this.toast = toast;
    this.clearStage = clearStage;
    this.data = { players: [], activePlayerId: null, leagues: [] };
    this.game = null;           // the round state (courseName, player, leagueRound)
    this.courses = [];          // downloaded courses, for the week pickers
    this.view = 'home';         // home | league | new | players
    this.leagueId = null;
    this.tab = 'standings';     // standings | week | schedule
    this.week = null;
    this.error = '';
    this.draft = null;          // the new-league form
    this.panel = $('league-panel');
    this.body = $('lg-body');
    this.panel.addEventListener('click', (e) => this._click(e));
    this.panel.addEventListener('change', (e) => this._change(e));
    this.panel.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) this._enter(e.target); });
    // the round card is the player switcher
    for (const id of ['player-avatar', 'player-name']) {
      const el = $(id);
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.title = 'Switch player';
      el.onclick = (e) => { e.stopPropagation(); this.togglePlayerMenu(); };
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.togglePlayerMenu(); } };
    }
    $('player-menu').addEventListener('click', (e) => this._playerMenuClick(e));
    document.addEventListener('click', (e) => { if (!$('player-menu').contains(e.target)) $('player-menu').classList.add('hidden'); });
    $('league-chip').onclick = () => this.open('home');
    this.refresh();
  }

  async refresh() {
    try { this.setData(await (await fetch('/api/leagues')).json()); } catch (_) { /* server starting */ }
  }

  setData(d) {
    if (!d || !Array.isArray(d.players)) return;
    this.data = { players: d.players, activePlayerId: d.activePlayerId, leagues: d.leagues || [] };
    if (this.leagueId && !this.league) { this.view = 'home'; this.leagueId = null; }
    this.render();
  }

  setGameState(s) {
    this.game = s;
    const lr = s && s.leagueRound;
    const chip = $('league-chip');
    chip.classList.toggle('hidden', !lr);
    if (lr) chip.innerHTML = `<span>LEAGUE</span> ${esc(lr.leagueName)} · wk ${lr.week}`;
    if (!this.panel.classList.contains('hidden')) this.render();
  }

  get league() { return this.data.leagues.find((l) => l.id === this.leagueId) || null; }
  playerName(id) { return this.data.players.find((p) => p.id === id)?.name || '?'; }

  toggle(force) {
    const show = force ?? this.panel.classList.contains('hidden');
    this.panel.classList.toggle('hidden', !show);
    $('btn-league').classList.toggle('active', show);
    if (show) { this.clearStage(); this.error = ''; this.render(); }
  }

  open(view = 'home', leagueId = null) {
    this.view = view;
    if (leagueId) this.leagueId = leagueId;
    if (view === 'new') this._startDraft();
    this.toggle(true);
  }

  // ---------- player switcher ----------
  togglePlayerMenu() {
    const m = $('player-menu');
    const show = m.classList.contains('hidden');
    const ps = this.data.players;
    m.innerHTML = (ps.length
      ? ps.map((p) => `<button class="menu-item${p.id === this.data.activePlayerId ? ' active' : ''}" data-player="${esc(p.id)}" role="menuitemradio" aria-checked="${p.id === this.data.activePlayerId}">
          <span class="pm-av">${esc(p.initials)}</span><span>${esc(p.name)}</span><em>${p.handicap ? `HCP ${p.handicap < 0 ? `+${-p.handicap}` : p.handicap}` : ''}</em></button>`).join('')
      : '<div class="pm-empty">No players yet</div>')
      + '<div class="menu-sep"></div><button class="menu-item" data-manage="1"><span>Manage players…</span></button>';
    m.classList.toggle('hidden', !show);
  }

  async _playerMenuClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    $('player-menu').classList.add('hidden');
    if (b.dataset.manage) { this.open('players'); return; }
    try { await post('/api/players/active', { id: b.dataset.player }); }
    catch (err) { this.toast('Players', err.message); }
  }

  // ---------- rendering ----------
  render() {
    if (this.panel.classList.contains('hidden')) return;
    const view = this.view === 'league' && !this.league ? 'home' : this.view;
    $('lg-title').textContent = view === 'league' ? this.league.name : view === 'new' ? 'New league' : view === 'players' ? 'Players' : 'Leagues';
    const err = this.error ? `<div class="lg-error">${esc(this.error)}</div>` : '';
    this.body.innerHTML = err + this._live() + (view === 'league' ? this._league() : view === 'new' ? this._new() : view === 'players' ? this._players() : this._home());
  }

  // the league round in play, on every view: whose card, and the way out of it
  _live() {
    const lr = this.game && this.game.leagueRound;
    return lr
      ? `<div class="lg-live"><div><span class="lbl">LEAGUE ROUND IN PLAY</span><b>${esc(lr.playerName)} · ${esc(lr.leagueName)}, week ${lr.week}</b>
         <span class="muted">Finish every hole and the card posts itself.</span></div><button class="chip" data-act="leave">Leave</button></div>`
      : '';
  }

  _home() {
    if (!this.data.players.length) {
      return `<p class="lg-intro">Add everyone who plays on this simulator. A handicap index is optional: net leagues use it.</p>${this._addPlayerRow()}`;
    }
    const cards = this.data.leagues.map((l) => {
      const lead = l.standings.find((s) => s.rounds > 0);
      return `<button class="lg-card" data-open="${esc(l.id)}">
        <b>${esc(l.name)}</b>
        <span>Week ${l.currentWeek} of ${l.weeks.length} · ${l.scoring === 'gross' ? 'Gross' : 'Net'} · ${l.playerIds.length} player${l.playerIds.length === 1 ? '' : 's'}</span>
        <span class="lg-lead">${lead ? `${esc(lead.name)} leads with ${pts(lead.points)} pts` : 'No cards in yet'}</span>
      </button>`;
    }).join('');
    return `${cards || '<p class="lg-intro">No leagues yet. A league is a season of weeks, a course each week; every player gets one card in per week, and places pay points.</p>'}
      <div class="lg-actions"><button class="btn primary" data-act="new">New league</button><button class="btn" data-act="players">Players</button></div>`;
  }

  _league() {
    const l = this.league;
    const tabs = ['standings', 'week', 'schedule'].map((t) => `<button role="radio" aria-checked="${this.tab === t}" data-tab="${t}">${t}</button>`).join('');
    const body = this.tab === 'week' ? this._week(l) : this.tab === 'schedule' ? this._schedule(l) : this._standings(l);
    return `<div class="lg-bar"><button class="chip" data-act="home">‹ Leagues</button>
      <div class="seg mini" role="radiogroup" aria-label="League view">${tabs}</div>
      <span class="lg-scoring">${l.scoring === 'gross' ? 'Gross' : 'Net'} scoring</span></div>${body}`;
  }

  _standings(l) {
    const rows = l.standings.map((s) => `<tr><td>${s.rank}</td><td class="lg-name">${esc(s.name)}</td><td><b>${pts(s.points)}</b></td>
      <td>${s.rounds}</td><td>${toPar(s.avg)}</td><td>${toPar(s.best)}</td><td>${s.wins || ''}</td></tr>`).join('');
    return `<table class="lg-table"><tr><th>#</th><th class="lg-name">Player</th><th>Pts</th><th>Cards</th><th>Avg</th><th>Best</th><th>Wins</th></tr>${rows}</table>
      <p class="lg-note">Each week pays ${'10 · 8 · 6 · 5 · 4 · 3 · 2'} points for 1st to 7th and 1 for every other card; ties share. Scores are ${l.scoring === 'gross' ? 'gross' : 'net of each player\'s handicap'}, to par.</p>`;
  }

  _week(l) {
    const n = this.week ?? l.currentWeek;
    const w = l.weeks.find((x) => x.n === n) || l.weeks[0];
    const board = l.weekBoards[w.n] || [];
    const done = new Set(board.map((r) => r.playerId));
    const todo = l.playerIds.filter((id) => !done.has(id));
    const here = this.game && this.game.courseName === w.course.name;
    const rows = board.map((r) => `<tr><td>${r.tied ? `T${r.rank}` : r.rank}</td><td class="lg-name">${esc(r.playerName)}</td><td>${r.gross}</td>
      <td>${r.net}</td><td><b>${toPar(l.scoring === 'gross' ? r.toPar : r.netToPar)}</b></td><td>${pts(r.points)}</td></tr>`).join('');
    const lr = this.game && this.game.leagueRound;
    const playing = (id) => lr && lr.leagueId === l.id && lr.week === w.n && lr.playerId === id;
    const play = todo.map((id) => (playing(id)
      ? `<span class="lg-play on"><b>${esc(this.playerName(id))}</b><span>Playing now</span></span>`
      : `<button class="lg-play" data-play="${esc(id)}" data-week="${w.n}"><b>${esc(this.playerName(id))}</b><span>Play ▶</span></button>`)).join('');
    return `<div class="lg-week">
        <button class="chip" data-week-step="-1" ${w.n <= 1 ? 'disabled' : ''} aria-label="Previous week">‹</button>
        <div><span class="lbl">WEEK ${w.n} OF ${l.weeks.length}${w.n === l.currentWeek ? ' · CURRENT' : ''}</span><b>${esc(short(w.course.name))}</b></div>
        <button class="chip" data-week-step="1" ${w.n >= l.weeks.length ? 'disabled' : ''} aria-label="Next week">›</button>
        ${w.n !== l.currentWeek ? `<button class="chip" data-current="${w.n}">Make current</button>` : ''}
      </div>
      ${board.length ? `<table class="lg-table"><tr><th>#</th><th class="lg-name">Player</th><th>Gross</th><th>Net</th><th>To par</th><th>Pts</th></tr>${rows}</table>` : '<p class="lg-note">No cards in for this week yet.</p>'}
      ${todo.length ? `<span class="lbl lg-sub">STILL TO PLAY${here ? '' : ` · loads ${esc(short(w.course.name))}`}</span><div class="lg-plays">${play}</div>` : '<p class="lg-note">Every card is in for this week.</p>'}`;
  }

  _schedule(l) {
    const weeks = l.weeks.map((w) => `<div class="lg-row"><span>Week ${w.n}${w.n === l.currentWeek ? ' <em>current</em>' : ''}</span><b>${esc(short(w.course.name))}</b>
      <span>${(l.weekBoards[w.n] || []).length}/${l.playerIds.length} cards</span>
      ${w.n !== l.currentWeek ? `<button class="chip" data-current="${w.n}">Make current</button>` : '<span></span>'}</div>`).join('');
    const members = l.playerIds.map((id) => `<span class="lg-member">${esc(this.playerName(id))}<button data-drop="${esc(id)}" aria-label="Take ${esc(this.playerName(id))} out of the league">×</button></span>`).join('');
    const others = this.data.players.filter((p) => !l.playerIds.includes(p.id));
    return `<span class="lbl lg-sub">WEEKS</span>${weeks}
      <div class="lg-add">${this._courseSelect('lg-week-course')}<button class="chip" data-act="add-week">Add a week</button></div>
      <span class="lbl lg-sub">PLAYERS</span><div class="lg-members">${members}</div>
      ${others.length ? `<div class="lg-add"><select id="lg-member-add">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select><button class="chip" data-act="add-member">Add to league</button></div>` : ''}
      <div class="lg-actions"><button class="btn danger" data-act="delete">Delete league</button></div>`;
  }

  _courseSelect(id, value = null) {
    const loaded = this.game && this.game.courseName;
    const list = this.courses.length ? this.courses : (loaded ? [{ name: loaded }] : []);
    const pick = value ?? (list.find((c) => c.name === loaded) || list[0])?.file;
    return `<select id="${id}" ${id === 'lg-week-course' ? '' : 'class="lg-wk"'}>${list.map((c) => `<option value="${esc(c.file || '')}" ${c.file === pick ? 'selected' : ''}>${esc(short(c.name))}</option>`).join('')}</select>`;
  }

  _startDraft() {
    const loaded = this.game && this.game.courseName;
    const first = this.courses.find((c) => c.name === loaded) || this.courses[0];
    this.draft = {
      name: '', scoring: 'net',
      playerIds: this.data.players.map((p) => p.id),
      weeks: Array.from({ length: 4 }, () => (first ? first.file : '')),
    };
    if (!this.courses.length) this._loadCourses();
  }

  _new() {
    const d = this.draft || (this._startDraft(), this.draft);
    const players = this.data.players.map((p) => `<label class="lg-check"><input type="checkbox" data-draft-player="${esc(p.id)}" ${d.playerIds.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('');
    const weeks = d.weeks.map((file, i) => `<div class="lg-row"><span>Week ${i + 1}</span>${this._courseSelect(`lg-wk-${i}`, file)}<span></span><span></span></div>`).join('');
    return `<label class="lg-field"><span class="lbl">NAME</span><input id="lg-name" type="text" maxlength="40" placeholder="e.g. Tuesday Night League" value="${esc(d.name)}"></label>
      <div class="lg-field"><span class="lbl">SCORING</span><div class="seg mini" role="radiogroup" aria-label="Scoring">
        <button role="radio" aria-checked="${d.scoring === 'net'}" data-scoring="net">Net (handicaps)</button>
        <button role="radio" aria-checked="${d.scoring === 'gross'}" data-scoring="gross">Gross</button></div></div>
      <div class="lg-field"><span class="lbl">PLAYERS</span><div class="lg-checks">${players || '<span class="muted">Add players first</span>'}</div></div>
      ${this._addPlayerRow()}
      <div class="lg-field"><span class="lbl">WEEKS · A COURSE EACH</span>${weeks}
        <div class="lg-add"><button class="chip" data-act="week-more">+ Week</button><button class="chip" data-act="week-less" ${d.weeks.length <= 1 ? 'disabled' : ''}>− Week</button></div></div>
      <div class="lg-actions"><button class="btn primary" data-act="create">Create league</button><button class="btn" data-act="home">Cancel</button></div>`;
  }

  _players() {
    const rows = this.data.players.map((p) => `<div class="lg-row lg-player">
        <input type="radio" name="lg-active" data-active="${esc(p.id)}" ${p.id === this.data.activePlayerId ? 'checked' : ''} aria-label="${esc(p.name)} is playing">
        <input type="text" maxlength="40" value="${esc(p.name)}" data-pname="${esc(p.id)}" aria-label="Name">
        <input type="text" inputmode="decimal" value="${p.handicap ? (p.handicap < 0 ? `+${-p.handicap}` : p.handicap) : ''}" placeholder="HCP" data-phcp="${esc(p.id)}" aria-label="Handicap index">
        <button class="chip" data-premove="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button></div>`).join('');
    return `<p class="lg-note">The selected player is the one playing now. Handicap index is optional (e.g. 12.4, or +2 for a plus handicap).</p>
      ${rows}${this._addPlayerRow()}<div class="lg-actions"><button class="btn" data-act="home">Done</button></div>`;
  }

  _addPlayerRow() {
    return `<div class="lg-add lg-newplayer"><input id="lg-new-name" type="text" maxlength="40" placeholder="Player name">
      <input id="lg-new-hcp" type="text" inputmode="decimal" placeholder="HCP"><button class="chip" data-act="add-player">Add player</button></div>`;
  }

  async _loadCourses() {
    try { this.courses = await (await fetch('/api/courses/cached')).json(); } catch (_) { this.courses = []; }
    if (this.draft) {
      const loaded = this.game && this.game.courseName;
      const first = this.courses.find((c) => c.name === loaded) || this.courses[0];
      this.draft.weeks = this.draft.weeks.map((f) => f || (first ? first.file : ''));
    }
    this.render();
  }

  courseFor(file) {
    const c = this.courses.find((x) => x.file === file);
    return c ? { cached: c.file, name: c.name, courseId: c.courseId } : null;
  }

  // ---------- actions ----------
  async _do(fn) {
    this.error = '';
    try { await fn(); } catch (err) { this.error = err.message; }
    this.render();
  }

  _click(e) {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const ds = t.dataset;
    if (ds.open) { this.leagueId = ds.open; this.view = 'league'; this.tab = 'standings'; this.week = null; this.error = ''; this.render(); return; }
    if (ds.tab) { this.tab = ds.tab; this.week = null; if (ds.tab === 'schedule' && !this.courses.length) this._loadCourses(); this.render(); return; }
    if (ds.weekStep) { const l = this.league; this.week = Math.min(l.weeks.length, Math.max(1, (this.week ?? l.currentWeek) + Number(ds.weekStep))); this.render(); return; }
    if (ds.scoring) { this.draft.scoring = ds.scoring; this.render(); return; }
    if (ds.current) { this._do(() => post('/api/leagues/update', { id: this.leagueId, currentWeek: Number(ds.current) })); this.week = null; return; }
    if (ds.drop) {
      const l = this.league;
      this._do(() => post('/api/leagues/update', { id: l.id, playerIds: l.playerIds.filter((id) => id !== ds.drop) }));
      return;
    }
    if (ds.premove) { this._do(() => post('/api/players/remove', { id: ds.premove })); return; }
    if (ds.play) { this._play(ds.play, Number(ds.week)); return; }
    const act = ds.act;
    if (act === 'home') { this.view = 'home'; this.leagueId = null; this.error = ''; this.render(); }
    else if (act === 'new') { this.view = 'new'; this._startDraft(); this.render(); }
    else if (act === 'players') { this.view = 'players'; this.render(); }
    else if (act === 'leave') this._do(() => post('/api/leagues/leave'));
    else if (act === 'add-player') this._addPlayer();
    else if (act === 'week-more') { this.draft.weeks.push(this.draft.weeks[this.draft.weeks.length - 1] || ''); this.render(); }
    else if (act === 'week-less') { if (this.draft.weeks.length > 1) this.draft.weeks.pop(); this.render(); }
    else if (act === 'create') this._create();
    else if (act === 'add-week') {
      const course = this.courseFor($('lg-week-course').value);
      this._do(() => post('/api/leagues/update', { id: this.leagueId, addWeek: { course } }));
    } else if (act === 'add-member') {
      const l = this.league;
      this._do(() => post('/api/leagues/update', { id: l.id, playerIds: [...l.playerIds, $('lg-member-add').value] }));
    } else if (act === 'delete') {
      const l = this.league;
      if (!window.confirm(`Delete ${l.name} and every card in it? This can't be undone.`)) return;
      this._do(async () => { await post('/api/leagues/remove', { id: l.id }); this.view = 'home'; this.leagueId = null; });
    }
  }

  _change(e) {
    const t = e.target;
    if (t.dataset.draftPlayer) {
      const ids = new Set(this.draft.playerIds);
      if (t.checked) ids.add(t.dataset.draftPlayer); else ids.delete(t.dataset.draftPlayer);
      this.draft.playerIds = this.data.players.map((p) => p.id).filter((id) => ids.has(id));
    } else if (t.id && t.id.startsWith('lg-wk-')) {
      this.draft.weeks[Number(t.id.slice(6))] = t.value;
    } else if (t.id === 'lg-name') {
      this.draft.name = t.value;
    } else if (t.dataset.active) {
      this._do(() => post('/api/players/active', { id: t.dataset.active }));
    } else if (t.dataset.pname) {
      this._do(() => post('/api/players/update', { id: t.dataset.pname, name: t.value }));
    } else if (t.dataset.phcp) {
      this._do(() => post('/api/players/update', { id: t.dataset.phcp, handicap: t.value }));
    }
  }

  _enter(input) {
    if (input.id === 'lg-new-name' || input.id === 'lg-new-hcp') this._addPlayer();
    else if (input.id === 'lg-name') { this.draft.name = input.value; this._create(); }
    else input.blur();   // a roster field: its change event saves it
  }

  _addPlayer() {
    const name = $('lg-new-name').value, handicap = $('lg-new-hcp').value;
    if (this.draft) this.draft.name = $('lg-name')?.value ?? this.draft.name;
    this._do(async () => {
      const { player } = await post('/api/players', { name, handicap });
      if (this.draft && !this.draft.playerIds.includes(player.id)) this.draft.playerIds.push(player.id);
    });
  }

  _create() {
    const d = this.draft;
    d.name = $('lg-name')?.value ?? d.name;
    this._do(async () => {
      const weeks = d.weeks.map((file) => ({ course: this.courseFor(file) })).filter((w) => w.course);
      const { league } = await post('/api/leagues', { name: d.name, scoring: d.scoring, playerIds: d.playerIds, weeks });
      this.draft = null;
      this.leagueId = league.id;
      this.view = 'league';
      this.tab = 'week';
    });
  }

  async _play(playerId, week) {
    const l = this.league;
    this.error = '';
    this.body.querySelectorAll('.lg-play').forEach((b) => { b.disabled = true; });
    try {
      await post('/api/leagues/play', { leagueId: l.id, week, playerId });
      this.toggle(false);
      this.clearStage();
      this.toast(`${this.playerName(playerId)}: ${l.name}, week ${week}`, 'Play every hole: the card posts itself at the end');
    } catch (err) {
      this.error = err.message;
      this.render();
    }
  }

  // A posted card (the 'league-card' event): where it stands this week.
  cardPosted(c) {
    if (!c || !c.posted) {
      if (c && c.reason === 'already') this.toast('Card not posted', `${c.playerName} already has a card for week ${c.week}`);
      return;
    }
    const r = c.round;
    const place = c.tied ? `T${c.rank}` : ['1st', '2nd', '3rd'][c.rank - 1] || `${c.rank}th`;
    this.toast(`Card posted: ${c.league}, week ${c.week}`, `${r.playerName} ${r.gross} (net ${r.net}) · ${place} of ${c.of} so far`);
  }
}
