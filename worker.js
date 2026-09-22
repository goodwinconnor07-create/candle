/**
 * Study Duel — a two-player study match run on a Durable Object.
 *
 * Each match gets its own GameRoom, which holds the only authoritative copy
 * of the state: what each player has scored so far, which question is up,
 * and who has answered it. Both players hold a WebSocket to that room, so a
 * ruling lands on both screens at the same moment rather than waiting for a
 * poll.
 *
 * How a match works:
 *   - Both players see the same question at the same time and have 10s.
 *   - Every answer is scored on the 3-7 grade scale: right is a 7, wrong or
 *     out of time is a 3. Running GPA is the mean of those scores, so it
 *     lands on values like 6.2 or 5.5 rather than jumping between whole
 *     grades.
 *   - Ten questions, then the higher final GPA wins. An exact tie on the
 *     displayed GPA falls to whoever answered faster overall.
 *
 * Judge Mode is the only mode wired up. The judge's ruling after each round
 * is built in judgeLine() and shipped as one line both players see — the
 * same shape a real model-written ruling will take, so swapping it later
 * touches nothing else.
 *
 * Routes:
 *   POST /api/games            create a room, returns {id, token}
 *   GET  /api/games/:id/ws     WebSocket, ?role=host|guest&token=...
 * Everything else is the static site in /public.
 */

const QUESTION_MS  = 10000;   // how long each question stays up
const RESOLVE_MS   = 3400;    // pause on the judge's ruling
const COUNTDOWN_MS = 3200;    // 3 - 2 - 1 before the first question
const TICK_MS      = 200;     // how often the room checks its own deadlines
const TOTAL_Q      = 10;      // questions in a match
const SCORE_RIGHT  = 7;       // high distinction for a correct answer
const SCORE_WRONG  = 3;       // fail for a wrong one, or for running out of time
const NAME_MAX     = 16;
const MODES        = { judge: 'Judge Mode' };
const ROOM_TTL_MS  = 24 * 60 * 60 * 1000;

function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init && init.headers) },
  });
}

function err(status, message) {
  return json({ error: message }, { status });
}

function randomId(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  raw.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

function rnd(n) { return Math.floor(Math.random() * n); }

function mean(list) {
  if (!list.length) return null;
  let sum = 0;
  for (const n of list) sum += n;
  return sum / list.length;
}

// one decimal is what players actually see, so rulings compare this and not
// the raw mean — otherwise two identical numbers on screen could disagree
function round1(n) { return Math.round(n * 10) / 10; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// placeholder subject: simple mental arithmetic, four choices, distractors
// that sit near the answer so you can't win by eyeballing the odd one out
function makeQuestion() {
  const adding = Math.random() < 0.6;
  let text, value;
  if (adding) {
    const a = 2 + rnd(12), b = 3 + rnd(12);
    text = a + ' + ' + b;
    value = a + b;
  } else {
    const a = 8 + rnd(14), b = 1 + rnd(7);
    text = a + ' − ' + b;
    value = a - b;
  }
  const pool = new Set([value]);
  while (pool.size < 4) {
    const off = (1 + rnd(4)) * (Math.random() < 0.5 ? -1 : 1);
    if (value + off >= 0) pool.add(value + off);
  }
  const choices = shuffle([...pool]);
  return { text, choices, answer: choices.indexOf(value) };
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();   // { ws, role }
    this.lobby = null;          // { hostName, hostToken, guestName, guestToken, guestReady, mode }
    this.game = null;           // in-memory while a match is running
    this.loop = null;
  }

  async loadLobby() {
    if (!this.lobby) this.lobby = (await this.state.storage.get('lobby')) || null;
    return this.lobby;
  }

  async saveLobby() {
    await this.state.storage.put('lobby', this.lobby);
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  // a finished room is just clutter; drop it a day later
  async alarm() {
    await this.state.storage.deleteAll();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/create') {
      const body = await request.json().catch(() => ({}));
      this.lobby = {
        hostName: clean(body.name, NAME_MAX) || 'Someone',
        hostToken: randomId(18),
        guestName: '',
        guestToken: '',
        guestReady: false,
        mode: MODES[body.mode] ? body.mode : 'judge',
      };
      await this.saveLobby();
      return json({ token: this.lobby.hostToken });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return err(426, 'expected websocket');
      const pair = new WebSocketPair();
      await this.accept(pair[1], url.searchParams);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return err(404, 'not found');
  }

  async accept(ws, params) {
    ws.accept();
    const lobby = await this.loadLobby();

    if (!lobby) {
      ws.send(JSON.stringify({ t: 'nogame' }));
      ws.close(1000, 'no such game');
      return;
    }

    const wanted = params.get('role');
    const token = params.get('token') || '';
    let role = null;

    if (wanted === 'host' && token && token === lobby.hostToken) {
      role = 'host';
    } else if (wanted === 'guest') {
      if (lobby.guestToken && token === lobby.guestToken) {
        role = 'guest';                       // coming back after a refresh
      } else if (!lobby.guestToken) {
        lobby.guestToken = randomId(18);      // first arrival claims the seat
        await this.saveLobby();
        role = 'guest';
      }
    }

    if (!role) {
      ws.send(JSON.stringify({ t: 'full' }));
      ws.close(1000, 'seat taken');
      return;
    }

    const conn = { ws, role };
    this.sockets.add(conn);

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this.onMessage(role, msg).catch(() => {});
    });
    const drop = () => this.sockets.delete(conn);
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);

    // the snapshot carries its own t:'state', so it has to be spread first or
    // it overwrites the welcome tag and the client never stores its token
    ws.send(JSON.stringify({
      ...this.snapshot(),
      t: 'welcome',
      you: role,
      token: role === 'host' ? lobby.hostToken : lobby.guestToken,
      questionMs: QUESTION_MS,
      total: TOTAL_Q,
      floor: SCORE_WRONG,
      ceiling: SCORE_RIGHT,
    }));
    this.broadcast(this.snapshot());
  }

  async onMessage(role, msg) {
    const lobby = await this.loadLobby();
    if (!lobby) return;

    if (msg.t === 'ready' && role === 'guest' && !this.game) {
      lobby.guestName = clean(msg.name, NAME_MAX) || 'Challenger';
      lobby.guestReady = true;
      await this.saveLobby();
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.t === 'start' && role === 'host' && lobby.guestReady && !this.game) {
      this.startGame();
      return;
    }

    if (msg.t === 'answer') {
      this.onAnswer(role, msg.round, msg.choice);
      return;
    }

    if (msg.t === 'again' && this.game && this.game.phase === 'over') {
      this.startGame();
    }
  }

  newPlayer(name) {
    return { name, scores: [], right: 0, ms: 0 };
  }

  startGame() {
    const now = Date.now();
    this.game = {
      phase: 'countdown',
      host: this.newPlayer(this.lobby.hostName),
      guest: this.newPlayer(this.lobby.guestName || 'Challenger'),
      round: 0,
      q: null,
      askedAt: 0,
      answers: {},
      deadline: now + COUNTDOWN_MS,
      last: null,
      over: null,
    };
    this.broadcast(this.snapshot());
    this.startLoop();
  }

  startLoop() {
    if (this.loop) return;
    this.loop = setInterval(() => {
      try { this.tick(); } catch (e) { /* a dropped tick just means a slightly late deadline */ }
    }, TICK_MS);
  }

  stopLoop() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  // the room only has to enforce its own deadlines; each browser runs the
  // visible countdown off the "ms left" it was handed with the question
  tick() {
    const g = this.game;
    if (!g || g.phase === 'over') { this.stopLoop(); return; }
    if (Date.now() < g.deadline) return;

    if (g.phase === 'countdown' || g.phase === 'resolve') this.nextRound();
    else if (g.phase === 'question') this.resolveRound();
  }

  gpaOf(p) {
    const m = mean(p.scores);
    return m == null ? null : round1(m);
  }

  nextRound() {
    const g = this.game;
    if (g.round >= TOTAL_Q) { this.endGame(); return; }
    const now = Date.now();
    g.round += 1;
    g.q = makeQuestion();
    g.answers = {};
    g.last = null;
    g.phase = 'question';
    g.askedAt = now;
    g.deadline = now + QUESTION_MS;
    this.broadcast(this.snapshot());
  }

  onAnswer(role, round, choice) {
    const g = this.game;
    if (!g || g.phase !== 'question' || round !== g.round) return;
    if (g.answers[role] != null) return;             // one answer per round
    g.answers[role] = { choice: Number(choice), at: Date.now() };
    if (g.answers.host != null && g.answers.guest != null) this.resolveRound();
    else this.broadcast(this.snapshot());            // so the other sees "they've locked in"
  }

  // the judge speaks once, to the room — both players read the same ruling.
  // a real model-written ruling drops in here and nothing else changes.
  judgeLine(lines) {
    const g = this.game;
    const h = g.host.name, s = g.guest.name;
    const missed = (l) => (l.timedOut ? 'ran out of time' : 'got it wrong');
    if (lines.host.right && lines.guest.right) return 'Both correct. Nothing between you on that one.';
    if (lines.host.right) return s + ' ' + missed(lines.guest) + '. That round goes to ' + h + '.';
    if (lines.guest.right) return h + ' ' + missed(lines.host) + '. That round goes to ' + s + '.';
    return 'Neither of you got that one. No marks either way.';
  }

  resolveRound() {
    const g = this.game;
    const now = Date.now();
    const correct = g.q.answer;
    const lines = {};

    for (const key of ['host', 'guest']) {
      const p = g[key];
      const given = g.answers[key];
      const right = given != null && given.choice === correct;
      const score = right ? SCORE_RIGHT : SCORE_WRONG;

      p.scores.push(score);
      if (right) p.right += 1;
      // a player who never answered is charged the whole question, so the
      // tiebreak can't be won by sitting out
      p.ms += given ? (given.at - g.askedAt) : QUESTION_MS;

      lines[key] = {
        answer: given ? given.choice : null,
        right,
        timedOut: given == null,
        score,
      };
    }

    g.last = { correct, host: lines.host, guest: lines.guest, line: this.judgeLine(lines) };
    g.phase = 'resolve';
    g.deadline = now + RESOLVE_MS;
    this.broadcast(this.snapshot());
  }

  endGame() {
    const g = this.game;
    const h = this.gpaOf(g.host) ?? 0;
    const s = this.gpaOf(g.guest) ?? 0;

    let over;
    if (h !== s) {
      over = { draw: false, winner: h > s ? 'host' : 'guest', byTime: false };
    } else if (g.host.ms !== g.guest.ms) {
      over = { draw: false, winner: g.host.ms < g.guest.ms ? 'host' : 'guest', byTime: true };
    } else {
      over = { draw: true };
    }

    g.phase = 'over';
    g.q = null;
    g.over = over;
    this.stopLoop();
    this.broadcast(this.snapshot());
  }

  side(p) {
    return {
      name: p.name,
      gpa: this.gpaOf(p),
      answered: p.scores.length,
      right: p.right,
      ms: p.ms,
    };
  }

  snapshot() {
    const lobby = this.lobby;
    const g = this.game;
    const mode = lobby ? lobby.mode : 'judge';

    if (!g) {
      return {
        t: 'state',
        phase: 'lobby',
        mode,
        modeName: MODES[mode],
        host: { name: lobby ? lobby.hostName : '', ready: true },
        guest: { name: lobby ? lobby.guestName : '', ready: !!(lobby && lobby.guestReady), here: !!(lobby && lobby.guestToken) },
      };
    }

    const now = Date.now();
    const snap = {
      t: 'state',
      phase: g.phase,
      mode,
      modeName: MODES[mode],
      round: g.round,
      total: TOTAL_Q,
      ms: Math.max(0, g.deadline - now),
      host: { ...this.side(g.host), answered_now: g.answers.host != null },
      guest: { ...this.side(g.guest), answered_now: g.answers.guest != null },
      last: g.last,
      over: g.over,
    };

    // never ship the answer index while the question is still live
    if (g.q) {
      snap.q = g.phase === 'question'
        ? { text: g.q.text, choices: g.q.choices }
        : { text: g.q.text, choices: g.q.choices, answer: g.q.answer };
    }
    return snap;
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const conn of [...this.sockets]) {
      try { conn.ws.send(payload); } catch (e) { this.sockets.delete(conn); }
    }
  }
}

async function api(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);   // ['api','games', id?, 'ws'?]

  if (parts[1] !== 'games') return err(404, 'not found');

  if (parts.length === 2 && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = randomId(9);
    const room = env.GAMES.get(env.GAMES.idFromName(id));
    const res = await room.fetch('https://room/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: body.name, mode: body.mode }),
    });
    const created = await res.json();
    return json({ id, token: created.token }, { status: 201 });
  }

  if (parts.length === 4 && parts[3] === 'ws') {
    const room = env.GAMES.get(env.GAMES.idFromName(parts[2]));
    return room.fetch('https://room/ws' + url.search, request);
  }

  return err(404, 'not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env);
      } catch (e) {
        return err(500, 'internal error');
      }
    }
    return env.ASSETS.fetch(request);
  },
};
