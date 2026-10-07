/**
 * Study Duel — two-player study mini games run on a Durable Object.
 *
 * Each match gets its own GameRoom, which holds the only authoritative copy
 * of the state. Both players hold a WebSocket to that room, so a shot or a
 * ruling lands on both screens at the same moment rather than waiting for a
 * poll.
 *
 * Pool is the only game for now: 8-ball where every shot has to be earned by
 * answering a question first. The room simulates each shot itself (pool.js)
 * and ships both phones the frames to replay.
 *
 * Judge Mode and Debate Mode used to live here too. They're kept on the
 * `archive/judge-debate-modes` branch.
 *
 * Routes:
 *   POST /api/games            create a room, returns {id, token}
 *   GET  /api/games/:id/ws     WebSocket, ?role=host|guest&token=...
 * Everything else is the static site in /public.
 */

import * as Pool from './pool.js';

const QUESTION_MS  = 10000;   // how long each question stays up
const COUNTDOWN_MS = 3200;    // 3 - 2 - 1 before the first question
const TICK_MS      = 200;     // how often the room checks its own deadlines
const NAME_MAX     = 16;
// every mini game gets an entry here; the lobby, test mode and leaving all
// work the same whichever one is picked
const MODES        = { pool: 'Pool' };

// ---- Pool ----
// every shot is earned: the shooter answers a question first, and a miss
// hands the table over without a shot being taken
const POOL_RESULT_MS = 1500;   // pause on right/wrong before the shot or handover
const AIM_MS         = 30000;  // shot clock once a question is answered right
const ROLL_PAD_MS    = 700;    // breathing room after the replay before the next question

// a dropped connection mid-match might just be a refresh or a locked phone,
// so the seat is held this long before the match is called off
const LEAVE_GRACE_MS = 15000;
// 'bot' isn't pickable: it's only ever given to the test stand-in
const CHARS        = ['boy', 'girl', 'dino', 'shades', 'ponytail', 'nerd', 'vampire', 'astronaut'];
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

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// a seat's character is picked in the browser, so it only counts if it's one
// we actually know about
function cleanChar(c) { return CHARS.indexOf(c) >= 0 ? c : ''; }

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
    this.lobby = null;          // { hostName, hostToken, guestName, guestToken, guestReady, mode, ... }
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
      // a test match fills the other seat with a stand-in, so it can be
      // played solo. a normal room is always two people
      const test = !!body.test;
      this.lobby = {
        hostName: clean(body.name, NAME_MAX) || 'Someone',
        hostToken: randomId(18),
        // the stand-in fills the guest seat immediately, ready and costumed
        guestName: test ? 'Tester' : '',
        guestToken: test ? 'bot' : '',
        guestReady: test,
        hostChar: cleanChar(body.char),
        guestChar: test ? 'bot' : '',
        mode: MODES[body.mode] ? body.mode : 'pool',
        vsBot: test,
        test,
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
    } else if (wanted === 'guest' && !lobby.vsBot) {
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
    if (this.game && this.game.gone) delete this.game.gone[role];   // back in time

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this.onMessage(role, msg).catch(() => {});
    });
    const drop = () => {
      if (!this.sockets.delete(conn)) return;
      const g = this.game;
      if (!g || g.phase === 'over') return;
      for (const c of this.sockets) if (c.role === role) return;   // still here on another tab
      g.gone = g.gone || {};
      g.gone[role] = Date.now();
    };
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
    }));
    this.broadcast(this.snapshot());
  }

  async onMessage(role, msg) {
    const lobby = await this.loadLobby();
    if (!lobby) return;

    if (msg.t === 'ready' && role === 'guest' && !this.game) {
      const char = cleanChar(msg.char);
      if (!char) return;                    // no character, no seat
      lobby.guestName = clean(msg.name, NAME_MAX) || 'Challenger';
      lobby.guestChar = char;
      lobby.guestReady = true;
      await this.saveLobby();
      this.broadcast(this.snapshot());
      return;
    }

    if (msg.t === 'start' && role === 'host' && lobby.guestReady
        && lobby.hostChar && lobby.guestChar && !this.game) {
      this.startGame();
      return;
    }

    if (msg.t === 'pans') { this.poolAnswer(role, msg.choice); return; }
    if (msg.t === 'shoot') { this.poolShoot(role, msg); return; }

    if (msg.t === 'leave') { this.playerLeft(role); return; }

    if (msg.t === 'again' && this.game && this.game.phase === 'over' && !this.game.over.left) {
      this.startGame();
    }
  }

  startGame() {
    const now = Date.now();
    const breaker = Math.random() < 0.5 ? 'host' : 'guest';
    this.game = {
      mode: 'pool',
      phase: 'countdown',
      host: { name: this.lobby.hostName, char: this.lobby.hostChar },
      guest: { name: this.lobby.guestName || 'Challenger', char: this.lobby.guestChar },
      q: null,
      deadline: now + COUNTDOWN_MS,
      over: null,
      vsBot: !!this.lobby.vsBot,
      test: !!this.lobby.test,
      botDueAt: 0,
      botChoice: null,
    };
    this.game.table = {
      balls: Pool.rack(),
      turn: breaker,
      groups: { host: null, guest: null },
      // the cue ball only comes into your hand after it's been potted;
      // the break, and every other foul, plays it from where it lies
      ballInHand: false,
      broken: false,
      shotId: 0,
      shot: null,
      after: null,
      call: this.game[breaker].name + ' breaks.',
      stats: { host: { asked: 0, right: 0 }, guest: { asked: 0, right: 0 } },
      pqResult: null,
    };
    this.broadcast(this.snapshot());
    this.startLoop();
  }

  // ---- Pool ----
  // a turn is: question → (right) aim and shoot → replay → next question.
  // a wrong answer or a timeout skips the shot and hands the table over.

  poolAsk() {
    const g = this.game;
    g.q = makeQuestion();
    g.table.pqResult = null;
    g.phase = 'pq';
    g.deadline = Date.now() + QUESTION_MS;
    if (g.vsBot && g.table.turn === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.broadcast(this.snapshot());
  }

  poolAnswer(role, choice) {
    const g = this.game;
    if (!g || g.phase !== 'pq' || role !== g.table.turn) return;
    const T = g.table;
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
    T.stats[role].asked += 1;
    if (right) T.stats[role].right += 1;
    T.pqResult = { choice: picked, right };
    g.phase = 'pqres';
    g.deadline = Date.now() + POOL_RESULT_MS;
    this.broadcast(this.snapshot());
  }

  // hand the table to the other player. the cue ball can only be in hand if
  // it's sitting in a pocket, so that's the one thing that carries over
  poolPass(call) {
    const T = this.game.table;
    T.turn = T.turn === 'host' ? 'guest' : 'host';
    T.ballInHand = T.balls[0].in;
    T.call = call;
    this.poolAsk();
  }

  poolShoot(role, msg) {
    const g = this.game;
    if (!g || g.phase !== 'aim' || role !== g.table.turn) return;
    const T = g.table;
    let dx = Number(msg.dx), dy = Number(msg.dy);
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0.0001) || !Number.isFinite(len)) return;
    dx /= len; dy /= len;
    const power = clamp(Number(msg.power) || 0, 0.03, 1);

    const before = T.balls.map((b) => ({ ...b }));
    if (T.ballInHand) {
      const cx = Number(msg.cx), cy = Number(msg.cy);
      if (!Pool.placeOk(before, cx, cy, false)) return;
      before[0] = { x: cx, y: cy, in: false };
    }

    // where on the cue ball they struck it, kept inside the edge of the ball
    let sx = Number(msg.sx) || 0, sy = Number(msg.sy) || 0;
    const sl = Math.sqrt(sx * sx + sy * sy);
    if (!Number.isFinite(sl)) { sx = 0; sy = 0; }
    else if (sl > Pool.SPIN_MAX) { sx *= Pool.SPIN_MAX / sl; sy *= Pool.SPIN_MAX / sl; }

    const sim = Pool.simulate(before, dx, dy, power * Pool.MAX_SPEED, { x: sx, y: sy });
    const rule = Pool.judgeShot({ balls: before, groups: T.groups, broken: T.broken }, sim, role);
    const shooter = role, other = role === 'host' ? 'guest' : 'host';
    const me = g[shooter].name, them = g[other].name;

    T.balls = sim.balls;
    if (rule.respot8) Pool.respot(T.balls, 8);
    T.groups = rule.groups;
    const wasBreak = !T.broken;
    T.broken = true;
    T.shotId += 1;
    T.shot = { id: T.shotId, frames: sim.frames };

    const down = rule.objects.filter((n) => n !== 8);
    const sank = down.length === 1 ? 'the ' + down[0] : (down.length ? down.length + ' balls' : '');
    let call;
    if (rule.win) {
      call = rule.win === shooter ? me + ' ' + rule.winWhy + '.' : me + ' ' + rule.winWhy + '. ' + them + ' wins.';
    } else if (rule.foul) {
      call = 'Foul, ' + rule.foul + '. ' + (T.balls[0].in ? them + ' has ball in hand.' : 'Over to ' + them + '.');
    } else if (rule.next === 'same') {
      call = wasBreak
        ? (sank ? me + ' sinks ' + sank + ' on the break and goes again.' : me + ' goes again.')
        : (rule.assigned ? me + ' sinks ' + sank + '. ' + me + ' is ' + rule.assigned + '.' : me + ' sinks ' + sank + ' and goes again.');
      if (rule.respot8) call += ' The 8 goes back on the spot.';
    } else {
      call = (sank ? me + ' sinks ' + sank + ' but not their own. ' : 'Nothing down. ') + 'Over to ' + them + '.';
    }

    T.after = {
      win: rule.win,
      winWhy: rule.win ? call : '',
      turn: rule.next === 'same' ? shooter : other,
      ballInHand: T.balls[0].in,
      call,
    };
    g.phase = 'rolling';
    g.deadline = Date.now() + Math.ceil(sim.frames.length * 1000 / Pool.FPS) + ROLL_PAD_MS;
    this.broadcast(this.snapshot());
  }

  poolTick(g) {
    const T = g.table;
    // the stand-in opponent's turns: answer after a moment, then shoot
    if (g.vsBot && T.turn === 'guest' && g.botDueAt && Date.now() >= g.botDueAt) {
      if (g.phase === 'pq') { g.botDueAt = 0; this.poolAnswer('guest', g.botChoice); return; }
      if (g.phase === 'aim') {
        g.botDueAt = 0;
        const shot = Pool.botShot(T.balls, T.groups, 'guest', T.broken, T.ballInHand);
        this.poolShoot('guest', shot);
        return;
      }
    }
    if (Date.now() < g.deadline) return;
    if (g.phase === 'countdown') { this.poolAsk(); return; }
    if (g.phase === 'pq') { this.poolAnswer(T.turn, null); return; }
    if (g.phase === 'pqres') {
      if (T.pqResult && T.pqResult.right) {
        g.phase = 'aim';
        g.deadline = Date.now() + AIM_MS;
        if (g.vsBot && T.turn === 'guest') g.botDueAt = Date.now() + 1200 + rnd(1300);
        T.call = g[T.turn].name + (!T.broken ? ' is breaking.' : ' is taking their shot.');
        this.broadcast(this.snapshot());
      } else {
        const them = g[T.turn === 'host' ? 'guest' : 'host'].name;
        this.poolPass((T.pqResult && T.pqResult.choice != null ? 'Wrong answer. ' : 'No answer. ') + 'Over to ' + them + '.');
      }
      return;
    }
    if (g.phase === 'aim') {
      const them = g[T.turn === 'host' ? 'guest' : 'host'].name;
      this.poolPass('Out of time. Over to ' + them + '.');
      return;
    }
    if (g.phase === 'rolling') {
      const a = T.after;
      T.shot = null;
      T.after = null;
      if (a.win) {
        g.phase = 'over';
        g.over = { winner: a.win, why: a.winWhy };
        T.call = a.call;
        this.stopLoop();
        this.broadcast(this.snapshot());
        return;
      }
      T.turn = a.turn;
      T.ballInHand = a.ballInHand;
      T.call = a.call;
      this.poolAsk();
    }
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

  // one player walked out: the match is over for both of them. after a match
  // has already finished it just stops a rematch being offered to nobody
  playerLeft(role) {
    const g = this.game;
    if (!g) return;
    const other = role === 'host' ? 'guest' : 'host';
    if (g.phase === 'over') {
      if (g.over && !g.over.left) { g.over.left = role; this.broadcast(this.snapshot()); }
      return;
    }
    g.phase = 'over';
    g.over = { winner: other, left: role, why: g[role].name + ' left the game.' };
    g.q = null;
    g.table.shot = null; g.table.after = null; g.table.call = g.over.why;
    this.stopLoop();
    this.broadcast(this.snapshot());
  }

  // the room only has to enforce its own deadlines; each browser runs the
  // visible countdown off the "ms left" it was handed with the question
  tick() {
    const g = this.game;
    if (!g || g.phase === 'over') { this.stopLoop(); return; }
    if (g.gone) {
      for (const role of Object.keys(g.gone)) {
        if (Date.now() - g.gone[role] > LEAVE_GRACE_MS) { this.playerLeft(role); return; }
      }
    }
    this.poolTick(g);
  }

  snapshot() {
    const lobby = this.lobby;
    const g = this.game;
    const mode = lobby && MODES[lobby.mode] ? lobby.mode : 'pool';

    if (!g) {
      return {
        t: 'state',
        phase: 'lobby',
        mode,
        modeName: MODES[mode],
        vsBot: !!(lobby && lobby.vsBot),
        test: !!(lobby && lobby.test),
        host: { name: lobby ? lobby.hostName : '', ready: true, char: lobby ? lobby.hostChar : '' },
        guest: {
          name: lobby ? lobby.guestName : '', ready: !!(lobby && lobby.guestReady),
          here: !!(lobby && lobby.guestToken), char: lobby ? lobby.guestChar : '',
        },
      };
    }

    const T = g.table;
    const snap = {
      t: 'state',
      phase: g.phase,
      mode,
      modeName: MODES[mode],
      test: !!g.test,
      ms: Math.max(0, g.deadline - Date.now()),
      host: { name: g.host.name, char: g.host.char },
      guest: { name: g.guest.name, char: g.guest.char },
      over: g.over,
      table: {
        balls: T.balls.map((b) => (b.in ? null : [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10])),
        turn: T.turn,
        groups: T.groups,
        ballInHand: T.ballInHand,
        broken: T.broken,
        call: T.call,
        stats: T.stats,
        pqResult: T.pqResult,
      },
    };
    // the replay rides along only while it's playing; the balls above are
    // already where it ends, so a late joiner just sees the settled table
    if (T.shot) snap.table.shot = T.shot;
    // never ship the answer index while the question is still live
    if (g.q && (g.phase === 'pq' || g.phase === 'pqres')) {
      snap.q = g.phase === 'pq'
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
      body: JSON.stringify({ name: body.name, mode: body.mode, char: body.char, test: body.test }),
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
