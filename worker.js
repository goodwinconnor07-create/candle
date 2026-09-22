/**
 * Candle Race — a two-player study race run on a Durable Object.
 *
 * Each game gets its own GameRoom, which holds the only authoritative copy of
 * the state: how much wax each player has left, who's burning fast right now,
 * which question is up, and whose streak is running. Both players hold a
 * WebSocket to that room, so a hit lands on the other candle immediately
 * rather than waiting for a poll.
 *
 * The rules, in one place:
 *   - Both players see the same question at the same time and have 10s.
 *   - Answer right and the OTHER candle burns fast for a few seconds.
 *   - Answer wrong, or run out of time, and YOUR candle burns fast instead.
 *   - Three right in a row hands you wax back.
 *   - Both candles burn at the base rate the whole time, so a game always ends.
 *   - First candle to run out loses.
 *
 * Routes:
 *   POST /api/games            create a room, returns {id, token}
 *   GET  /api/games/:id/ws     WebSocket, ?role=host|guest&token=...
 * Everything else is the static site in /public.
 */

const START_WAX_MS = 180000;  // 3 minutes of candle at the base burn rate
const QUESTION_MS  = 10000;   // how long each question stays up
const RESOLVE_MS   = 2600;    // pause showing what the round did
const COUNTDOWN_MS = 3200;    // 3 - 2 - 1 before the first question
const TICK_MS      = 250;     // how often the room broadcasts wax levels
const BURST_RATE   = 3;       // a hit candle burns this many times faster
const BURST_MS     = 4000;    // and stays that way this long
const BURST_CAP_MS = 12000;   // stacked hits can't push it past this
const STREAK_N     = 3;       // right answers in a row that earn wax back
const HEAL_MS      = 20000;   // how much wax a streak hands back
const NAME_MAX     = 16;
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

function rateOf(p, now) { return p.burstUntil > now ? BURST_RATE : 1; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// simple mental arithmetic, four choices, distractors that sit near the answer
// so you can't win by eyeballing which number looks out of place
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
    this.lobby = null;          // { hostName, hostToken, guestName, guestToken, guestReady }
    this.game = null;           // in-memory while a race is running
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
      };
      await this.saveLobby();
      return json({ token: this.lobby.hostToken, hostName: this.lobby.hostName });
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
      startWax: START_WAX_MS,
      questionMs: QUESTION_MS,
      streakN: STREAK_N,
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
    return { name, wax: START_WAX_MS, burstUntil: 0, streak: 0, best: 0, right: 0 };
  }

  startGame() {
    const now = Date.now();
    this.game = {
      phase: 'countdown',
      host: this.newPlayer(this.lobby.hostName),
      guest: this.newPlayer(this.lobby.guestName || 'Challenger'),
      round: 0,
      q: null,
      answers: {},
      deadline: now + COUNTDOWN_MS,
      lastTick: now,
      last: null,
      over: null,
    };
    this.broadcast(this.snapshot());
    this.startLoop();
  }

  startLoop() {
    if (this.loop) return;
    this.loop = setInterval(() => {
      try { this.tick(); } catch (e) { /* a dropped tick just means a slightly coarser burn */ }
    }, TICK_MS);
  }

  stopLoop() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  tick() {
    const g = this.game;
    if (!g || g.phase === 'over') { this.stopLoop(); return; }

    const now = Date.now();
    const dt = now - g.lastTick;
    g.lastTick = now;

    // the base burn never stops, so an evenly matched race still finishes
    for (const key of ['host', 'guest']) {
      const p = g[key];
      p.wax = Math.max(0, p.wax - dt * rateOf(p, now));
    }

    if (g.host.wax <= 0 || g.guest.wax <= 0) { this.endGame(); return; }

    if (now >= g.deadline) {
      if (g.phase === 'countdown' || g.phase === 'resolve') this.nextRound();
      else if (g.phase === 'question') this.resolveRound();
      return;
    }

    this.broadcast({ t: 'tick', h: this.waxOf(g.host), g: this.waxOf(g.guest), ms: Math.max(0, g.deadline - now) });
  }

  // read the rate live rather than off the last tick, so the flare shows up in
  // the very message that reports the hit instead of a tick later
  waxOf(p) { return { w: Math.round(p.wax), r: rateOf(p, Date.now()) }; }

  nextRound() {
    const g = this.game;
    g.round += 1;
    g.q = makeQuestion();
    g.answers = {};
    g.last = null;
    g.phase = 'question';
    g.deadline = Date.now() + QUESTION_MS;
    this.broadcast(this.snapshot());
  }

  onAnswer(role, round, choice) {
    const g = this.game;
    if (!g || g.phase !== 'question' || round !== g.round) return;
    if (g.answers[role] != null) return;             // one answer per round
    g.answers[role] = Number(choice);
    if (g.answers.host != null && g.answers.guest != null) this.resolveRound();
    else this.broadcast(this.snapshot());            // so the other sees "they've locked in"
  }

  burn(p, now) {
    // stacked hits extend the burst rather than multiplying the rate, so a
    // bad round hurts without turning into a runaway
    p.burstUntil = Math.min(Math.max(now, p.burstUntil) + BURST_MS, now + BURST_CAP_MS);
  }

  resolveRound() {
    const g = this.game;
    const now = Date.now();
    const correct = g.q.answer;
    const result = { correct, host: null, guest: null };

    for (const key of ['host', 'guest']) {
      const me = g[key];
      const them = g[key === 'host' ? 'guest' : 'host'];
      const given = g.answers[key];
      const right = given != null && given === correct;
      const line = { answer: given == null ? null : given, right, timedOut: given == null, healed: false };

      if (right) {
        me.streak += 1;
        me.right += 1;
        me.best = Math.max(me.best, me.streak);
        this.burn(them, now);
        if (me.streak % STREAK_N === 0) {
          me.wax = Math.min(START_WAX_MS, me.wax + HEAL_MS);
          line.healed = true;
        }
      } else {
        me.streak = 0;
        this.burn(me, now);
      }
      line.streak = me.streak;
      result[key] = line;
    }

    g.last = result;
    g.phase = 'resolve';
    g.deadline = now + RESOLVE_MS;
    this.broadcast(this.snapshot());
  }

  endGame() {
    const g = this.game;
    const hostOut = g.host.wax <= 0;
    const guestOut = g.guest.wax <= 0;
    g.phase = 'over';
    g.q = null;
    g.over = hostOut && guestOut
      ? { draw: true }
      : { draw: false, loser: hostOut ? 'host' : 'guest', winner: hostOut ? 'guest' : 'host' };
    this.stopLoop();
    this.broadcast(this.snapshot());
  }

  snapshot() {
    const lobby = this.lobby;
    const g = this.game;

    if (!g) {
      return {
        t: 'state',
        phase: 'lobby',
        host: { name: lobby ? lobby.hostName : '', ready: true },
        guest: { name: lobby ? lobby.guestName : '', ready: !!(lobby && lobby.guestReady), here: !!(lobby && lobby.guestToken) },
      };
    }

    const now = Date.now();
    const snap = {
      t: 'state',
      phase: g.phase,
      round: g.round,
      ms: Math.max(0, g.deadline - now),
      host: { name: g.host.name, ...this.waxOf(g.host), streak: g.host.streak, best: g.host.best, right: g.host.right, answered: g.answers.host != null },
      guest: { name: g.guest.name, ...this.waxOf(g.guest), streak: g.guest.streak, best: g.guest.best, right: g.guest.right, answered: g.answers.guest != null },
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
      body: JSON.stringify({ name: body.name }),
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
