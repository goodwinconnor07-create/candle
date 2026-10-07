/**
 * Study Duel — two-player study mini games run on a Durable Object.
 *
 * Each match gets its own GameRoom, which holds the only authoritative copy
 * of the state. Both players hold a WebSocket to that room, so a shot or a
 * ruling lands on both screens at the same moment rather than waiting for a
 * poll.
 *
 * Pool: 8-ball where every shot has to be earned by answering a question
 * first. The room simulates each shot itself (public/pool.js) and sends both
 * phones the shot, which they run through the same simulation to draw it.
 *
 * Chess: moves always alternate, so nobody ever gets two in a row. Each move
 * still needs a right answer first, but a wrong one costs time off your chess
 * clock and you get another question. Three right in a row unlocks the best
 * move for as long as the streak lasts. The rules live in public/chess.js,
 * which the browser loads too.
 *
 * Battleships: both players lay out their fleets, then take turns firing.
 * Every shot needs a right answer first. A wrong one shows the other player
 * one empty square of yours and asks again; every third right answer in a
 * row shows you one empty square of theirs. Each player is only ever sent
 * their own fleet. The rules live in public/battleships.js, which the browser
 * loads too.
 *
 * Towers: a tower-battle game after Clash Royale, played in rounds. In a
 * study round the arena is frozen and both players answer a set of questions
 * at their own pace: every right answer is elixir, the only elixir there is.
 * Then a short battle round runs in real time with no questions at all. The
 * battle itself is in towers.js, the cards and the arena in
 * public/towers-cards.js.
 *
 * Judge Mode and Debate Mode used to live here too. They're kept on the
 * `archive/judge-debate-modes` branch.
 *
 * Routes:
 *   POST /api/games            create a room, returns {id, token}
 *   POST /api/games/:id/code   host only ({token}), returns {code}: a
 *                              6-digit code a friend can type instead of
 *                              opening the link
 *   GET  /api/codes/:code      returns {id} for a live code, or 404
 *   GET  /api/games/:id/ws     WebSocket, ?role=host|guest&token=...
 * Everything else is the static site in /public.
 */

import * as Pool from './public/pool.js';
import * as Chess from './public/chess.js';
import * as Sea from './public/battleships.js';
import * as Towers from './towers.js';
import * as Cards from './public/towers-cards.js';
import * as Golf from './public/golf.js';
import { Feed } from './questions.js';

const QUESTION_MS  = 10000;   // how long each question stays up
const COUNTDOWN_MS = 3200;    // 3 - 2 - 1 before the first question
const TICK_MS      = 200;     // how often the room checks its own deadlines
const NAME_MAX     = 16;
// every mini game gets an entry here; the lobby, test mode and leaving all
// work the same whichever one is picked
const MODES        = { pool: 'Pool', chess: 'Chess', battleships: 'Battleships', towers: 'Towers', golf: 'Mini Golf' };

// ---- Pool ----
// every shot is earned: the shooter answers a question first, and a miss
// hands the table over without a shot being taken
const POOL_RESULT_MS = 1500;   // pause on right/wrong before the shot or handover
const AIM_MS         = 30000;  // shot clock once a question is answered right
const ROLL_PAD_MS    = 700;    // breathing room after the replay before the next question

// ---- Chess ----
// a wrong answer never hands over a move: it costs clock time instead, and
// you get another question. turns always alternate
const CHESS_CLOCK_MS  = 5 * 60 * 1000;   // each player's clock
const CHESS_PENALTY_MS = 15000;          // off your clock for a wrong answer or no answer
const CHESS_RESULT_MS = 1500;            // pause on right/wrong; the clock stops for it
const HINT_STREAK     = 3;               // right answers in a row that unlock the best move

// ---- Battleships ----
// a wrong answer never costs the shot: it gives away one of your empty
// squares and you get another question. turns always alternate
const SEA_PLACE_MS  = 90000;   // to lay out a fleet; whatever's on the board then is locked in
const SEA_RESULT_MS = 1500;    // pause on right/wrong before firing or the next question
const SEA_AIM_MS    = 20000;   // to pick a square once a question is answered right
const SEA_SHOT_MS   = 1700;    // pause on a splash or a hit before the next turn
const SEA_SUNK_MS   = 2400;    // a little longer when a ship goes down
const SEA_STREAK    = 3;       // right answers in a row that clear one of their squares

// ---- Towers ----
// rounds: a frozen study round where both players answer their own set of
// questions, then a live battle round with no questions in it. elixir only
// comes from right answers
const TOWERS_TICK_MS   = 100;     // one battle step; both screens get a picture every step
const STUDY_QS         = 4;       // questions per player per study round
const STUDY_MS         = 30000;   // a study round ends when both are done, or at this
const BATTLE_TICKS     = 250;     // 25s of battle per round
const ROUNDS           = 7;       // regular rounds, about 3 minutes of battle
const OT_ROUNDS        = 2;       // sudden-death rounds if the crowns are level
const RUSH_ROUNDS      = 2;       // the last regular rounds pay extra
const ELIXIR_PER_RIGHT = 2.5;     // a perfect study round fills the bar
const ELIXIR_STREAK    = 0.5;     // extra from your third right answer in a row on
const ELIXIR_RUSH      = 1;       // extra in rush and overtime rounds
const SHOW_RIGHT_MS    = 700;     // how long a right answer shows before the next question
const SHOW_WRONG_MS    = 1500;    // a wrong one shows a little longer, with the right answer

// ---- Mini golf ----
// players take turns, like pool. a right answer earns the stroke; a wrong
// one (or no answer) adds a penalty stroke and asks again. water and out of
// bounds cost a stroke too, and the ball goes back where it was hit from
const GOLF_HOLES     = 3;       // holes per match, picked at random from the course
const GOLF_RESULT_MS = 1500;    // pause on right/wrong
const GOLF_AIM_MS    = 30000;   // to take the stroke once it's earned
const GOLF_PAD_MS    = 900;     // after the ball stops, before the next question
const GOLF_HOLE_MS   = 4000;    // the scorecard between holes

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

// 100000-999999, so a code never starts with a zero someone might drop
function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0];
  return String(100000 + (n % 900000));
}

function codeBook(env, code) {
  return env.CODES.get(env.CODES.idFromName(code));
}

// One tiny Durable Object per join code, holding the room id it points at.
// Claiming a code happens inside the object, so two rooms can never end up
// with the same one. A code lasts as long as a room would, and is let go as
// soon as someone takes the guest seat.
export class JoinCode {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const now = Date.now();
    let entry = await this.state.storage.get('entry');
    if (entry && entry.until < now) entry = null;

    if (url.pathname === '/claim') {
      if (entry && entry.id !== body.id) return json({ ok: false });
      await this.state.storage.put('entry', { id: body.id, until: now + ROOM_TTL_MS });
      await this.state.storage.setAlarm(now + ROOM_TTL_MS);
      return json({ ok: true });
    }
    if (url.pathname === '/lookup') {
      return entry ? json({ id: entry.id }) : err(404, 'no such code');
    }
    if (url.pathname === '/release') {
      if (entry && entry.id === body.id) await this.state.storage.deleteAll();
      return json({ ok: true });
    }
    return err(404, 'not found');
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

function rnd(n) { return Math.floor(Math.random() * n); }


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

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();   // { ws, role }
    this.lobby = null;          // { hostName, hostToken, guestName, guestToken, guestReady, mode, ... }
    this.game = null;           // in-memory while a match is running
    this.loop = null;
    this.codeClaim = null;      // a code request in flight, so two at once share it
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
        // Towers decks; the stand-in brings a random one
        hostDeck: Cards.cleanDeck(body.deck),
        guestDeck: test ? shuffle(Cards.CARD_KEYS.slice()).slice(0, Cards.DECK_SIZE) : Cards.DEFAULT_DECK.slice(),
      };
      await this.saveLobby();
      return json({ token: this.lobby.hostToken });
    }

    if (url.pathname === '/code') {
      const body = await request.json().catch(() => ({}));
      const lobby = await this.loadLobby();
      if (!lobby || !body.token || body.token !== lobby.hostToken) return err(403, 'not the host');
      if (lobby.vsBot) return err(400, 'test matches have no code');
      if (lobby.closed) return err(410, 'called off');
      if (lobby.guestToken) return err(409, 'the guest seat is taken');
      if (lobby.code) return json({ code: lobby.code });
      if (!this.codeClaim) {
        this.codeClaim = this.claimCode(body.id).finally(() => { this.codeClaim = null; });
      }
      const code = await this.codeClaim;
      return code ? json({ code }) : err(503, 'no free code, try again');
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return err(426, 'expected websocket');
      const pair = new WebSocketPair();
      await this.accept(pair[1], url.searchParams);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return err(404, 'not found');
  }

  async claimCode(id) {
    for (let i = 0; i < 8; i++) {
      const code = randomCode();
      const res = await codeBook(this.env, code).fetch('https://code/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if ((await res.json()).ok) {
        this.lobby.code = code;
        this.lobby.id = id;
        await this.saveLobby();
        return code;
      }
    }
    return null;
  }

  async accept(ws, params) {
    ws.accept();
    const lobby = await this.loadLobby();

    if (!lobby) {
      ws.send(JSON.stringify({ t: 'nogame' }));
      ws.close(1000, 'no such game');
      return;
    }
    if (lobby.closed) {
      ws.send(JSON.stringify({ t: 'closed', name: lobby.hostName }));
      ws.close(1000, 'called off');
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
        // the seat's gone, so the code has nothing left to open
        if (lobby.code) {
          codeBook(this.env, lobby.code).fetch('https://code/release', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: lobby.id }),
          }).catch(() => {});
        }
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
      if (!g) { this.sendState(); return; }   // the lobby shows who's still connected
      if (g.phase === 'over') return;
      for (const c of this.sockets) if (c.role === role) return;   // still here on another tab
      g.gone = g.gone || {};
      g.gone[role] = Date.now();
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);

    // the snapshot carries its own t:'state', so it has to be spread first or
    // it overwrites the welcome tag and the client never stores its token
    ws.send(JSON.stringify({
      ...this.snapshot(role),
      t: 'welcome',
      you: role,
      token: role === 'host' ? lobby.hostToken : lobby.guestToken,
      questionMs: QUESTION_MS,
    }));
    this.sendState();
  }

  async onMessage(role, msg) {
    if (!msg || typeof msg !== 'object') return;   // valid JSON, but not a message
    const lobby = await this.loadLobby();
    if (!lobby) return;

    if (msg.t === 'ready' && role === 'guest' && !this.game) {
      const char = cleanChar(msg.char);
      if (!char) return;                    // no character, no seat
      lobby.guestName = clean(msg.name, NAME_MAX) || 'Challenger';
      lobby.guestChar = char;
      lobby.guestDeck = Cards.cleanDeck(msg.deck);
      lobby.guestReady = true;
      await this.saveLobby();
      this.sendState();
      return;
    }

    // walking out of the lobby on purpose. a guest frees their seat for
    // someone else; a host calls the whole match off
    if (msg.t === 'leave' && !this.game) { await this.lobbyLeave(role); return; }

    if (msg.t === 'start' && role === 'host' && lobby.guestReady
        && lobby.hostChar && lobby.guestChar && !this.game) {
      this.startGame();
      return;
    }

    if (msg.t === 'pans') { this.poolAnswer(role, msg.choice); return; }
    if (msg.t === 'shoot') { this.poolShoot(role, msg); return; }
    if (msg.t === 'cans') { this.chessAnswer(role, msg.choice); return; }
    if (msg.t === 'move') { this.chessMove(role, msg); return; }
    if (msg.t === 'place' || msg.t === 'sready') { this.seaPlace(role, msg); return; }
    if (msg.t === 'bans') { this.seaAnswer(role, msg.choice); return; }
    if (msg.t === 'fire') { this.seaFire(role, msg); return; }
    if (msg.t === 'tans') { this.towersAnswer(role, msg.choice, msg.id); return; }
    if (msg.t === 'play') { this.towersPlay(role, msg); return; }
    if (msg.t === 'gans') { this.golfAnswer(role, msg.choice); return; }
    if (msg.t === 'stroke') { this.golfStroke(role, msg); return; }

    if (msg.t === 'leave') { this.playerLeft(role); return; }

    if (msg.t === 'again' && this.game && this.game.phase === 'over' && !this.game.over.left) {
      this.startGame();
    }
  }

  startGame() {
    const now = Date.now();
    const mode = MODES[this.lobby.mode] ? this.lobby.mode : 'pool';
    const breaker = Math.random() < 0.5 ? 'host' : 'guest';
    this.game = {
      mode,
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
    if (mode === 'towers') {
      const lobby = this.lobby;
      this.game.battle = Towers.newBattle({ host: lobby.hostDeck, guest: lobby.guestDeck });
      this.game.tq = { host: this.towersQ0(), guest: this.towersQ0() };
      this.game.round = 0;
      this.game.ot = false;
      this.game.bt = 0;
      this.game.botLast = -99;
      this.sendState();
      this.towersSend();
      this.startLoop(TOWERS_TICK_MS);
      return;
    }
    if (mode === 'golf') {
      // three different holes, in a random order
      const ids = Golf.HOLE_IDS.slice();
      for (let i = ids.length - 1; i > 0; i--) { const j = rnd(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      this.game.golf = {
        holes: ids.slice(0, GOLF_HOLES),
        i: 0,
        turn: breaker,
        first: breaker,           // who teed off this hole
        balls: null,
        seen: '',
        strokes: { host: [], guest: [] },
        shotId: 0,
        shot: null,
        after: null,
        pen: null,                // the latest penalty stroke, so both screens can flash it
        pens: 0,
        call: '',
        stats: { host: { asked: 0, right: 0 }, guest: { asked: 0, right: 0 } },
        gqResult: null,
      };
      this.golfTee();
      this.game.golf.call = this.game[breaker].name + ' tees off first.';
      this.sendState();
      this.startLoop();
      return;
    }
    if (mode === 'chess') {
      // white is picked at random, the way pool picks who breaks
      const pos = Chess.start();
      this.game.chess = {
        pos,
        colors: { host: breaker === 'host' ? 'w' : 'b', guest: breaker === 'host' ? 'b' : 'w' },
        clock: { host: CHESS_CLOCK_MS, guest: CHESS_CLOCK_MS },
        since: 0,               // when the running clock last started; 0 means stopped
        keys: [Chess.posKey(pos)],
        sans: [],
        last: null,
        call: this.game[breaker].name + ' has white and moves first.',
        stats: { host: { asked: 0, right: 0 }, guest: { asked: 0, right: 0 } },
        streak: { host: 0, guest: 0 },
        cqResult: null,
        penalty: null,          // { role, id } so both screens can flash the -15s
        penalties: 0,
      };
      this.sendState();
      this.startLoop();
      return;
    }
    if (mode === 'battleships') {
      // both fleets start out placed at random, so there's always a legal
      // layout to lock in, even if someone never touches theirs
      const board = () => ({
        fleet: Sea.randomFleet(),
        shots: Array(Sea.SIZE * Sea.SIZE).fill('.'),   // landed here: 'o' miss, 'x' hit
        marks: Array(Sea.SIZE * Sea.SIZE).fill('.'),   // shown to be empty: 'r' gave away, 'b' streak
      });
      this.game.phase = 'place';
      this.game.deadline = now + SEA_PLACE_MS;
      this.game.sea = {
        turn: breaker,
        boards: { host: board(), guest: board() },
        // the stand-in is happy with its random layout
        ready: { host: false, guest: !!this.lobby.vsBot },
        call: 'Place your ships.',
        stats: { host: { asked: 0, right: 0, shots: 0, hits: 0 }, guest: { asked: 0, right: 0, shots: 0, hits: 0 } },
        streak: { host: 0, guest: 0 },
        bqResult: null,
        last: null,       // the latest shot, so both screens can play it
        reveal: null,     // the latest square given away
        shots: 0,
        reveals: 0,
        after: null,
      };
      this.sendState();
      this.startLoop();
      return;
    }
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
    this.sendState();
    this.startLoop();
  }

  // each player has their own feed of questions for the match. Nothing about
  // a question beyond its text and choices goes into a snapshot.
  nextQ(role) {
    const g = this.game;
    if (!g.feeds) g.feeds = { host: new Feed(), guest: new Feed() };
    return g.feeds[role].next();
  }

  feedResult(role, q, right) {
    const f = this.game.feeds && this.game.feeds[role];
    if (f) f.result(q, right);
  }

  // ---- Pool ----
  // a turn is: question → (right) aim and shoot → replay → next question.
  // a wrong answer or a timeout skips the shot and hands the table over.

  poolAsk() {
    const g = this.game;
    g.q = this.nextQ(g.table.turn);
    g.table.pqResult = null;
    g.phase = 'pq';
    g.deadline = Date.now() + QUESTION_MS;
    if (g.vsBot && g.table.turn === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.sendState();
  }

  poolAnswer(role, choice) {
    const g = this.game;
    if (!g || g.phase !== 'pq' || role !== g.table.turn) return;
    const T = g.table;
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
    this.feedResult(role, g.q, right);
    T.stats[role].asked += 1;
    if (right) T.stats[role].right += 1;
    T.pqResult = { choice: picked, right };
    g.phase = 'pqres';
    g.deadline = Date.now() + POOL_RESULT_MS;
    this.sendState();
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
    if (!g || !g.table || g.phase !== 'aim' || role !== g.table.turn) return;
    const T = g.table;
    // the shooter's browser runs this same conversion and the same shot the
    // moment they let go, so it has to stay in pool.js where both can use it
    const shot = Pool.shotFrom(T.balls, T.ballInHand, msg);
    if (!shot) return;
    const { before } = shot;
    const sim = Pool.simulate(before, shot.dx, shot.dy, shot.speed, shot.spin, { fps: 0 });
    const rule = Pool.judgeShot({ balls: before, groups: T.groups, broken: T.broken }, sim, role);
    const shooter = role, other = role === 'host' ? 'guest' : 'host';
    const me = g[shooter].name, them = g[other].name;

    T.balls = sim.balls;
    if (rule.respot8) Pool.respot(T.balls, 8);
    T.groups = rule.groups;
    const wasBreak = !T.broken;
    T.broken = true;
    T.shotId += 1;
    // the shot itself, not a recording of it: both browsers run it through
    // simulate() and get exactly what the room got. positions go out in full,
    // since a ball a hair out of place could roll somewhere else entirely
    T.shot = {
      id: T.shotId,
      start: before.map((b) => (b.in ? null : [b.x, b.y])),
      dx: shot.dx, dy: shot.dy, speed: shot.speed, sx: shot.spin.x, sy: shot.spin.y,
    };

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
    g.deadline = Date.now() + Math.ceil(sim.secs * 1000) + ROLL_PAD_MS;
    this.sendState();
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
        this.sendState();
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
        this.sendState();
        return;
      }
      T.turn = a.turn;
      T.ballInHand = a.ballInHand;
      T.call = a.call;
      this.poolAsk();
    }
  }

  // ---- Mini golf ----
  // a turn is: question → (right) stroke → watch it roll → the next player's
  // question. a wrong answer adds a stroke and asks the same player again.

  golfHole() { return Golf.hole(this.game.golf.holes[this.game.golf.i]); }

  // both balls on the tee of the current hole, and the fog back over it
  golfTee() {
    const G = this.game.golf, H = this.golfHole();
    G.balls = {
      host: { x: H.tee.x, y: H.tee.y, done: false },
      guest: { x: H.tee.x, y: H.tee.y, done: false },
    };
    G.strokes.host[G.i] = 0;
    G.strokes.guest[G.i] = 0;
    G.seen = Golf.freshSeen(H);
  }

  golfAsk() {
    const g = this.game, G = g.golf;
    g.q = this.nextQ(G.turn);
    G.gqResult = null;
    g.phase = 'gq';
    g.deadline = Date.now() + QUESTION_MS;
    if (g.vsBot && G.turn === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.sendState();
  }

  golfAnswer(role, choice) {
    const g = this.game;
    if (!g || !g.golf || g.phase !== 'gq' || role !== g.golf.turn) return;
    const G = g.golf;
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
    this.feedResult(role, g.q, right);
    G.stats[role].asked += 1;
    if (right) G.stats[role].right += 1;
    G.gqResult = { choice: picked, right };
    g.phase = 'gqres';
    g.deadline = Date.now() + GOLF_RESULT_MS;
    this.sendState();
  }

  // a stroke added without the ball moving. returns true if that was the
  // last one this hole allows, and the ball's been picked up
  golfPenalty(role) {
    const G = this.game.golf;
    G.strokes[role][G.i] += 1;
    G.pens += 1;
    G.pen = { role, id: G.pens };
    return this.golfCapped(role);
  }

  golfCapped(role) {
    const G = this.game.golf, b = G.balls[role];
    if (b.done || G.strokes[role][G.i] < Golf.MAX_STROKES) return false;
    G.strokes[role][G.i] = Golf.MAX_STROKES;
    b.done = true;
    b.picked = true;
    return true;
  }

  // whoever's next: the other player if they're still out there, or the
  // same one again if the other has finished. both done ends the hole
  golfNext(call) {
    const g = this.game, G = g.golf;
    const other = G.turn === 'host' ? 'guest' : 'host';
    G.call = call;
    if (G.balls.host.done && G.balls.guest.done) { this.golfHoleOver(); return; }
    if (!G.balls[other].done) G.turn = other;
    this.golfAsk();
  }

  golfHoleOver() {
    const g = this.game, G = g.golf;
    const H = this.golfHole();
    const hs = G.strokes.host[G.i], gs = G.strokes.guest[G.i];
    const line = (r) => g[r].name + ' ' + G.strokes[r][G.i];
    G.call = 'Hole ' + (G.i + 1) + ' done: ' + line('host') + ', ' + line('guest') + ' (par ' + H.par + ').';
    g.q = null;
    if (G.i + 1 >= G.holes.length) {
      const tot = (r) => G.strokes[r].reduce((a, b) => a + b, 0);
      const th = tot('host'), tg = tot('guest');
      const winner = th === tg ? null : th < tg ? 'host' : 'guest';
      g.phase = 'over';
      g.over = {
        winner,
        why: winner ? g[winner].name + ' wins by ' + Math.abs(th - tg) + (Math.abs(th - tg) === 1 ? ' stroke' : ' strokes') + ', ' + Math.min(th, tg) + ' to ' + Math.max(th, tg) + '.'
          : 'All square on ' + th + ' strokes.',
      };
      G.call = g.over.why;
      this.stopLoop();
      this.sendState();
      return;
    }
    // the better score on this hole tees off the next; level, and the
    // other player gets their turn to go first
    G.next = hs === gs ? (G.first === 'host' ? 'guest' : 'host') : hs < gs ? 'host' : 'guest';
    g.phase = 'holeend';
    g.deadline = Date.now() + GOLF_HOLE_MS;
    this.sendState();
  }

  golfStroke(role, msg) {
    const g = this.game;
    if (!g || !g.golf || g.phase !== 'aim' || role !== g.golf.turn) return;
    const G = g.golf, H = this.golfHole(), b = G.balls[role];
    // the browser runs this same conversion and the same shot as soon as the
    // player lets go, so it has to stay in golf.js where both can use it
    const shot = Golf.shotFrom(msg);
    if (!shot) return;
    const sim = Golf.simulate(H, b.x, b.y, shot, { fps: 0 });
    G.strokes[role][G.i] += 1;
    G.shotId += 1;
    G.shot = { id: G.shotId, role, x: b.x, y: b.y, dx: shot.dx, dy: shot.dy, power: shot.power, club: shot.club };
    G.seen = Golf.reveal(H, G.seen, sim.marks);
    const me = g[role].name, n = G.strokes[role][G.i];
    let call;
    if (sim.result === 'holed') {
      b.x = H.cup.x; b.y = H.cup.y; b.done = true;
      const toPar = n - H.par;
      call = n === 1 ? 'Hole in one! ' + me + ' aces it.'
        : me + ' holes out in ' + n + (toPar <= -2 ? '. Eagle!' : toPar === -1 ? '. Birdie!' : toPar === 0 ? ', par.' : toPar === 1 ? ', a bogey.' : '.');
    } else if (sim.result === 'water' || sim.result === 'out') {
      // the ball comes back where it was hit from, and it costs a stroke
      const capped = this.golfPenalty(role);
      call = (sim.result === 'water' ? 'Splash. ' : 'Out of bounds. ') + 'Penalty stroke for ' + me + '.'
        + (capped ? ' That\'s ' + Golf.MAX_STROKES + ', so ' + me + ' picks up.' : '');
    } else {
      b.x = sim.end.x; b.y = sim.end.y;
      const capped = this.golfCapped(role);
      call = capped ? me + ' has had ' + Golf.MAX_STROKES + ' and picks up.' : '';
    }
    G.after = { call };
    g.phase = 'rolling';
    g.deadline = Date.now() + Math.ceil(sim.secs * 1000) + GOLF_PAD_MS;
    this.sendState();
  }

  golfTick(g) {
    const G = g.golf;
    if (g.vsBot && G.turn === 'guest' && g.botDueAt && Date.now() >= g.botDueAt) {
      if (g.phase === 'gq') { g.botDueAt = 0; this.golfAnswer('guest', g.botChoice); return; }
      if (g.phase === 'aim') {
        g.botDueAt = 0;
        const b = G.balls.guest;
        this.golfStroke('guest', Golf.botShot(this.golfHole(), b.x, b.y));
        return;
      }
    }
    if (Date.now() < g.deadline) return;
    const who = g[G.turn].name;
    if (g.phase === 'countdown') { this.golfAsk(); return; }
    if (g.phase === 'gq') { this.golfAnswer(G.turn, null); return; }
    if (g.phase === 'gqres') {
      if (G.gqResult && G.gqResult.right) {
        g.phase = 'aim';
        g.deadline = Date.now() + GOLF_AIM_MS;
        if (g.vsBot && G.turn === 'guest') g.botDueAt = Date.now() + 1200 + rnd(1300);
        G.call = who + ' is lining up.';
        this.sendState();
        return;
      }
      // a wrong answer is a stroke, and the same player goes again
      const capped = this.golfPenalty(G.turn);
      const why = G.gqResult && G.gqResult.choice != null ? 'Wrong answer' : 'No answer';
      if (capped) { this.golfNext(why + '. That\'s ' + Golf.MAX_STROKES + ', so ' + who + ' picks up.'); return; }
      G.call = why + ', penalty stroke. ' + who + ' tries again.';
      this.golfAsk();
      return;
    }
    if (g.phase === 'aim') {
      const capped = this.golfPenalty(G.turn);
      this.golfNext('Out of time, penalty stroke for ' + who + '.' + (capped ? ' ' + who + ' picks up.' : ''));
      return;
    }
    if (g.phase === 'rolling') {
      const a = G.after;
      G.shot = null;
      G.after = null;
      this.golfNext(a.call);
      return;
    }
    if (g.phase === 'holeend') {
      G.i += 1;
      G.turn = G.next;
      G.first = G.next;
      this.golfTee();
      const H = this.golfHole();
      G.call = 'Hole ' + (G.i + 1) + ', ' + H.name + ', par ' + H.par + '. ' + g[G.turn].name + ' has the honour.';
      this.golfAsk();
    }
  }

  golfSnapshot(mode) {
    const g = this.game, G = g.golf, H = this.golfHole();
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
      golf: {
        hole: H.id, n: G.i + 1, of: G.holes.length, holes: G.holes,
        // exact, not rounded: the player's browser runs its stroke from these
        balls: G.balls,
        strokes: G.strokes,
        turn: G.turn,
        seen: G.seen,
        call: G.call,
        stats: G.stats,
        gqResult: G.gqResult,
        pen: G.pen,
      },
    };
    // the stroke rides along only while it's rolling; the balls above are
    // already where it ends
    if (G.shot) snap.golf.shot = G.shot;
    if (g.q && (g.phase === 'gq' || g.phase === 'gqres')) {
      snap.q = g.phase === 'gq'
        ? { text: g.q.text, choices: g.q.choices }
        : { text: g.q.text, choices: g.q.choices, answer: g.q.answer };
    }
    return snap;
  }

  // ---- Chess ----
  // a turn is: question → (right) move → the other player's question.
  // a wrong answer or a timeout costs clock time and asks again. the clock
  // runs through your question and your move, and stops for the result pause

  chessTurn() {
    const C = this.game.chess;
    return C.colors.host === C.pos.turn ? 'host' : 'guest';
  }

  // what's left on a clock right now, counting the turn that's under way
  chessLeft(role) {
    const C = this.game.chess;
    const running = C.since && role === this.chessTurn() ? Date.now() - C.since : 0;
    return Math.max(0, C.clock[role] - running);
  }

  chessRun() {
    const C = this.game.chess;
    if (!C.since) C.since = Date.now();
  }

  chessStop() {
    const C = this.game.chess;
    if (!C.since) return;
    const role = this.chessTurn();
    C.clock[role] = Math.max(0, C.clock[role] - (Date.now() - C.since));
    C.since = 0;
  }

  chessAsk() {
    const g = this.game, C = g.chess;
    g.q = this.nextQ(this.chessTurn());
    C.cqResult = null;
    g.phase = 'cq';
    g.deadline = Date.now() + QUESTION_MS;
    this.chessRun();
    if (g.vsBot && this.chessTurn() === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.sendState();
  }

  chessAnswer(role, choice) {
    const g = this.game;
    if (!g || g.mode !== 'chess' || g.phase !== 'cq' || role !== this.chessTurn()) return;
    const C = g.chess;
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
    this.feedResult(role, g.q, right);
    this.chessStop();
    C.stats[role].asked += 1;
    if (right) {
      C.stats[role].right += 1;
      C.streak[role] += 1;
    } else {
      C.streak[role] = 0;
      C.clock[role] = Math.max(0, C.clock[role] - CHESS_PENALTY_MS);
      C.penalties += 1;
      C.penalty = { role, id: C.penalties };
    }
    C.cqResult = { choice: picked, right };
    g.phase = 'cqres';
    g.deadline = Date.now() + CHESS_RESULT_MS;
    this.sendState();
  }

  chessMove(role, msg) {
    const g = this.game;
    if (!g || g.mode !== 'chess' || g.phase !== 'move' || role !== this.chessTurn()) return;
    const C = g.chess;
    const all = Chess.moves(C.pos);
    const from = Number(msg.from), to = Number(msg.to);
    const promo = ['q', 'r', 'b', 'n'].indexOf(msg.promo) >= 0 ? msg.promo : 'q';
    const m = all.find((x) => x.from === from && x.to === to && (!x.promo || x.promo === promo));
    if (!m) return;

    this.chessStop();
    const san = Chess.san(C.pos, m, all);
    C.pos = Chess.make(C.pos, m);
    C.keys.push(Chess.posKey(C.pos));
    C.sans.push(san);
    C.last = { from: m.from, to: m.to };
    const me = g[role].name;
    const ended = Chess.status(C.pos, C.keys);
    if (ended === 'checkmate') { this.chessOver(role, me + ' plays ' + san + '. Checkmate.'); return; }
    if (ended) {
      const why = { stalemate: 'Stalemate', material: 'Not enough pieces left to mate',
        fifty: 'Fifty moves without a capture or a pawn move', repetition: 'Same position three times' }[ended];
      this.chessOver(null, me + ' plays ' + san + '. ' + why + ', so it\'s a draw.');
      return;
    }
    C.call = me + ' plays ' + san + '.';
    this.chessAsk();
  }

  // winner is a role, or null for a draw
  chessOver(winner, why) {
    const g = this.game;
    if (g.chess.since) this.chessStop();
    g.phase = 'over';
    g.q = null;
    g.over = { winner, draw: !winner, why };
    g.chess.call = why;
    this.stopLoop();
    this.sendState();
  }

  // out of time loses, unless the other side couldn't ever mate
  chessFlag(role) {
    const g = this.game, C = g.chess;
    C.clock[role] = 0;
    C.since = 0;
    const other = role === 'host' ? 'guest' : 'host';
    if (!Chess.canMate(C.pos.b, C.colors[other])) {
      this.chessOver(null, g[role].name + ' ran out of time, but ' + g[other].name + " can't mate with what's left. Draw.");
    } else {
      this.chessOver(other, g[role].name + ' ran out of time.');
    }
  }

  chessTick(g) {
    const C = g.chess, turn = this.chessTurn();
    if ((g.phase === 'cq' || g.phase === 'move') && this.chessLeft(turn) <= 0) { this.chessFlag(turn); return; }
    // the stand-in opponent's turns: answer after a moment, then move
    if (g.vsBot && turn === 'guest' && g.botDueAt && Date.now() >= g.botDueAt) {
      if (g.phase === 'cq') { g.botDueAt = 0; this.chessAnswer('guest', g.botChoice); return; }
      if (g.phase === 'move') {
        g.botDueAt = 0;
        const m = Chess.botMove(C.pos);
        if (m) this.chessMove('guest', { from: m.from, to: m.to, promo: m.promo });
        return;
      }
    }
    if (g.phase === 'countdown') {
      if (Date.now() >= g.deadline) this.chessAsk();
      return;
    }
    if (g.phase === 'cq' && Date.now() >= g.deadline) { this.chessAnswer(turn, null); return; }
    if (g.phase === 'cqres' && Date.now() >= g.deadline) {
      const name = g[turn].name;
      if (C.clock[turn] <= 0) { this.chessFlag(turn); return; }
      if (C.cqResult && C.cqResult.right) {
        g.phase = 'move';
        g.q = null;
        this.chessRun();
        if (g.vsBot && turn === 'guest') g.botDueAt = Date.now() + 1000 + rnd(1500);
        C.call = C.streak[turn] >= HINT_STREAK
          ? name + ' is on a streak of ' + C.streak[turn] + ' and gets the best move.'
          : name + ' is choosing a move.';
        this.sendState();
      } else {
        C.call = (C.cqResult && C.cqResult.choice != null ? 'Wrong answer. ' : 'No answer. ')
          + name + ' loses ' + (CHESS_PENALTY_MS / 1000) + ' seconds. Another question.';
        this.chessAsk();
      }
    }
  }

  // ---- Battleships ----
  // first both players lay out their fleets. then a turn is: question →
  // (right) fire → the other player's question. a wrong answer or a timeout
  // gives away one of your empty squares and asks again

  seaPlace(role, msg) {
    const g = this.game;
    if (!g || g.mode !== 'battleships' || g.phase !== 'place') return;
    const S = g.sea;
    if (S.ready[role]) return;
    const fleet = Sea.cleanFleet(msg.ships);
    if (fleet) S.boards[role].fleet = fleet;
    // a layout change only matters to the room; nobody else gets to see it
    if (msg.t !== 'sready') return;
    S.ready[role] = true;
    if (S.ready.host && S.ready.guest) this.seaCountdown();
    else this.sendState();
  }

  seaCountdown() {
    const g = this.game, S = g.sea;
    S.ready.host = S.ready.guest = true;
    g.phase = 'countdown';
    g.deadline = Date.now() + COUNTDOWN_MS;
    S.call = g[S.turn].name + ' fires first.';
    this.sendState();
  }

  seaAsk() {
    const g = this.game, S = g.sea;
    g.q = this.nextQ(S.turn);
    S.bqResult = null;
    g.phase = 'bq';
    g.deadline = Date.now() + QUESTION_MS;
    if (g.vsBot && S.turn === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.sendState();
  }

  // mark one empty square on this board that nobody has fired at or been
  // shown yet, for the other player to see
  seaReveal(owner, kind) {
    const S = this.game.sea, B = S.boards[owner], open = [];
    for (let sq = 0; sq < Sea.SIZE * Sea.SIZE; sq++) {
      if (B.shots[sq] === '.' && B.marks[sq] === '.' && Sea.shipAt(B.fleet, sq) < 0) open.push(sq);
    }
    if (!open.length) return null;
    const sq = open[rnd(open.length)];
    B.marks[sq] = kind;
    S.reveals += 1;
    S.reveal = { board: owner, sq, kind, id: S.reveals };
    return S.reveal;
  }

  seaAnswer(role, choice) {
    const g = this.game;
    if (!g || g.mode !== 'battleships' || g.phase !== 'bq' || role !== g.sea.turn) return;
    const S = g.sea, other = role === 'host' ? 'guest' : 'host';
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
    this.feedResult(role, g.q, right);
    S.stats[role].asked += 1;
    let reveal = null;
    if (right) {
      S.stats[role].right += 1;
      S.streak[role] += 1;
      if (S.streak[role] % SEA_STREAK === 0) reveal = this.seaReveal(other, 'b');
    } else {
      S.streak[role] = 0;
      reveal = this.seaReveal(role, 'r');
    }
    S.bqResult = { choice: picked, right, reveal };
    g.phase = 'bqres';
    g.deadline = Date.now() + SEA_RESULT_MS;
    this.sendState();
  }

  seaFire(role, msg) {
    const g = this.game;
    if (!g || g.mode !== 'battleships' || g.phase !== 'fire' || role !== g.sea.turn) return;
    const S = g.sea, other = role === 'host' ? 'guest' : 'host', B = S.boards[other];
    const sq = Number(msg.sq);
    if (!Number.isInteger(sq) || sq < 0 || sq >= Sea.SIZE * Sea.SIZE) return;
    if (B.shots[sq] !== '.' || B.marks[sq] !== '.') return;

    const ship = Sea.shipAt(B.fleet, sq);
    B.shots[sq] = ship >= 0 ? 'x' : 'o';
    S.stats[role].shots += 1;
    if (ship >= 0) S.stats[role].hits += 1;
    const sunk = Sea.sunkList(B.fleet, B.shots);
    const down = ship >= 0 && sunk[ship] ? ship : -1;
    const won = sunk.every(Boolean);
    S.shots += 1;
    S.last = { by: role, sq, hit: ship >= 0, sunk: down, id: S.shots };

    const me = g[role].name, them = g[other].name, at = Sea.coord(sq);
    const name = down >= 0 ? Sea.FLEET[down].name : '';
    if (won) S.call = me + ' sinks the ' + name + ', the last of ' + them + "'s fleet.";
    else if (down >= 0) S.call = me + ' fires at ' + at + ' and sinks the ' + name + '.';
    else S.call = me + ' fires at ' + at + (ship >= 0 ? '. Hit!' : '. Miss.');
    S.after = won ? { win: role, why: S.call } : null;
    g.phase = 'shot';
    g.deadline = Date.now() + (down >= 0 ? SEA_SUNK_MS : SEA_SHOT_MS);
    this.sendState();
  }

  seaTick(g) {
    const S = g.sea, now = Date.now();
    const other = S.turn === 'host' ? 'guest' : 'host';
    // the stand-in opponent's turns: answer after a moment, then fire
    if (g.vsBot && S.turn === 'guest' && g.botDueAt && now >= g.botDueAt) {
      if (g.phase === 'bq') { g.botDueAt = 0; this.seaAnswer('guest', g.botChoice); return; }
      if (g.phase === 'fire') {
        g.botDueAt = 0;
        const B = S.boards.host, sunkCells = new Set();
        Sea.sunkList(B.fleet, B.shots).forEach((down, i) => {
          if (down) Sea.cells(B.fleet[i], Sea.FLEET[i].len).forEach((c) => sunkCells.add(c));
        });
        this.seaFire('guest', { sq: Sea.botFire(B.shots, B.marks, sunkCells) });
        return;
      }
    }
    if (now < g.deadline) return;
    if (g.phase === 'place') { this.seaCountdown(); return; }
    if (g.phase === 'countdown') { this.seaAsk(); return; }
    if (g.phase === 'bq') { this.seaAnswer(S.turn, null); return; }
    if (g.phase === 'bqres') {
      const r = S.bqResult || {}, name = g[S.turn].name;
      if (r.right) {
        g.phase = 'fire';
        g.q = null;
        g.deadline = now + SEA_AIM_MS;
        if (g.vsBot && S.turn === 'guest') g.botDueAt = now + 1000 + rnd(1300);
        S.call = name + ' is picking a square to fire at.';
        this.sendState();
      } else {
        S.call = (r.choice != null ? 'Wrong answer. ' : 'No answer. ')
          + (r.reveal ? name + ' gives away an empty square. ' : '') + 'Another question.';
        this.seaAsk();
      }
      return;
    }
    if (g.phase === 'fire') {
      S.call = 'Out of time. Over to ' + g[other].name + '.';
      S.turn = other;
      this.seaAsk();
      return;
    }
    if (g.phase === 'shot') {
      if (S.after) {
        g.phase = 'over';
        g.q = null;
        g.over = { winner: S.after.win, why: S.after.why };
        this.stopLoop();
        this.sendState();
        return;
      }
      S.turn = other;
      this.seaAsk();
    }
  }

    // ---- Towers ----
  // the room steps the battle every 100ms and sends each player the shared
  // picture plus their own hand, elixir and question. a question's answer
  // only goes out once it's been answered

  towersQ0() {
    return { list: [], i: 0, results: [], id: 0, state: 'wait', readyAt: 0, last: null,
             streak: 0, asked: 0, right: 0, botAt: 0, botChoice: 0 };
  }

  towersRush() {
    const g = this.game;
    return g.ot || g.round > ROUNDS - RUSH_ROUNDS;
  }

  // a study round: a fresh set of questions each, and the arena stands still
  towersStudy() {
    const g = this.game;
    g.round += 1;
    g.phase = 'study';
    g.phaseEnd = Date.now() + STUDY_MS;
    for (const role of ['host', 'guest']) {
      const Q = g.tq[role];
      Q.list = [];
      for (let i = 0; i < STUDY_QS; i++) Q.list.push(this.nextQ(role));
      Q.i = 0;
      Q.results = [];
      this.towersAsk(role);
    }
    this.sendState();
  }

  towersBattle() {
    const g = this.game;
    g.phase = 'battle';
    g.bt = 0;
    for (const role of ['host', 'guest']) {
      const Q = g.tq[role];
      if (Q.state === 'ask') { Q.results[Q.i] = null; Q.streak = 0; }   // a question left unanswered breaks the streak
      Q.state = 'off';
    }
    this.sendState();
  }

  towersAsk(role) {
    const g = this.game, Q = g.tq[role];
    Q.id += 1;
    Q.state = 'ask';
    Q.last = null;
    const q = Q.list[Q.i];
    if (g.vsBot && role === 'guest') {
      Q.botAt = Date.now() + 1500 + rnd(2000);
      Q.botChoice = Math.random() < .75 ? q.answer : (q.answer + 1 + rnd(3)) % 4;
    }
  }

  towersAnswer(role, choice, id) {
    const g = this.game;
    if (!g || g.mode !== 'towers' || g.phase !== 'study') return;
    const Q = g.tq[role];
    if (Q.state !== 'ask' || (id != null && Number(id) !== Q.id)) return;
    const q = Q.list[Q.i];
    const picked = choice == null ? null : Number(choice);
    const right = picked === q.answer;
    this.feedResult(role, q, right);
    Q.asked += 1;
    let gain = 0;
    if (right) {
      Q.right += 1;
      Q.streak += 1;
      gain = ELIXIR_PER_RIGHT + (Q.streak >= 3 ? ELIXIR_STREAK : 0) + (this.towersRush() ? ELIXIR_RUSH : 0);
      Towers.addElixir(g.battle, role, gain);
    } else {
      Q.streak = 0;
    }
    Q.results[Q.i] = right;
    Q.state = right ? 'right' : 'wrong';
    Q.readyAt = Date.now() + (right ? SHOW_RIGHT_MS : SHOW_WRONG_MS);
    Q.last = { id: Q.id, choice: picked, right, gain };
    this.towersSend();
  }

  towersPlay(role, msg) {
    const g = this.game;
    if (!g || g.mode !== 'towers') return;
    const slot = Number(msg.slot);
    if (!(slot >= 0 && slot < 4)) return;
    if (g.phase !== 'battle') { this.sendTo(role, { t: 'bno', why: 'study', slot }); return; }
    const side = g.battle.sides[role];
    // the hand only changes when you play, so a mismatch is a stale double tap
    if (msg.card != null && Cards.CARD_KEYS[Number(msg.card)] !== side.hand[slot]) return;
    const why = Towers.play(g.battle, role, slot, Number(msg.x), Number(msg.y));
    if (why) this.sendTo(role, { t: 'bno', why, slot });
  }

  // a player's own question, as they're allowed to see it: never the answer
  // while it's still live
  towersQuestion(role) {
    const g = this.game, Q = g.tq[role];
    const out = { state: Q.state, i: Q.i, n: STUDY_QS, results: Q.results, streak: Q.streak };
    const q = Q.list[Q.i];
    if (q && (Q.state === 'ask' || Q.state === 'right' || Q.state === 'wrong')) {
      out.id = Q.id; out.text = q.text; out.choices = q.choices;
      if (Q.state !== 'ask' && Q.last && Q.last.id === Q.id) {
        out.answer = q.answer; out.choice = Q.last.choice; out.gain = Q.last.gain;
      }
    }
    return out;
  }

  towersLeft() {
    const g = this.game;
    if (g.phase === 'countdown') return STUDY_MS;
    if (g.phase === 'study') return Math.max(0, g.phaseEnd - Date.now());
    if (g.phase === 'battle') return (BATTLE_TICKS - g.bt) * TOWERS_TICK_MS;
    return 0;
  }

  towersSend() {
    const g = this.game, s = g.battle;
    const base = {
      t: 'bt', ph: g.phase, tl: this.towersLeft(), rush: this.towersRush() ? 1 : 0,
      cd: g.phase === 'countdown' ? Math.max(0, g.deadline - Date.now()) : 0,
      round: g.round, rounds: g.ot ? ROUNDS + OT_ROUNDS : ROUNDS, ot: g.ot ? 1 : 0,
      st: [g.tq.host.streak, g.tq.guest.streak],
      done: [g.tq.host.state === 'done' ? 1 : 0, g.tq.guest.state === 'done' ? 1 : 0],
      ...Towers.world(s),
    };
    for (const conn of [...this.sockets]) {
      const msg = { ...base, me: { ...Towers.mine(s, conn.role), q: this.towersQuestion(conn.role) } };
      try { conn.ws.send(JSON.stringify(msg)); } catch (e) { this.sockets.delete(conn); }
    }
  }

  towersTick(g) {
    const now = Date.now();
    if (g.phase === 'countdown') {
      if (now >= g.deadline) this.towersStudy();
      this.towersSend();
      return;
    }

    if (g.phase === 'study') {
      for (const role of ['host', 'guest']) {
        const Q = g.tq[role];
        if ((Q.state === 'right' || Q.state === 'wrong') && now >= Q.readyAt) {
          Q.i += 1;
          if (Q.i < STUDY_QS) this.towersAsk(role); else Q.state = 'done';
        } else if (g.vsBot && role === 'guest' && Q.state === 'ask' && now >= Q.botAt) {
          this.towersAnswer('guest', Q.botChoice, Q.id);
        }
      }
      // over when both have finished, or when time's up
      if ((g.tq.host.state === 'done' && g.tq.guest.state === 'done') || now >= g.phaseEnd) this.towersBattle();
      this.towersSend();
      return;
    }

    // battle: the arena runs, no questions
    const s = g.battle;
    if (g.vsBot && g.bt % 5 === 0 && g.bt - g.botLast >= 10) {
      const p = Towers.botPlay(s, 'guest');
      if (p && !Towers.play(s, 'guest', p.slot, p.x, p.y)) g.botLast = g.bt;
    }
    Towers.step(s);
    g.bt += 1;

    const h = s.sides.host.crowns, c = s.sides.guest.crowns;
    if (s.kingDown === 'both') { this.towersOver(null, 'kings'); return; }
    if (s.kingDown) { this.towersOver(s.kingDown === 'host' ? 'guest' : 'host', 'king'); return; }
    // in overtime the first tower to fall settles it
    if (g.ot && h !== c) { this.towersOver(h > c ? 'host' : 'guest', 'overtime'); return; }
    if (g.bt >= BATTLE_TICKS) {
      g.botLast = -99;
      if (g.round === ROUNDS && !g.ot) {
        if (h !== c) { this.towersOver(h > c ? 'host' : 'guest', 'time'); return; }
        g.ot = true;
      }
      if (g.ot && g.round >= ROUNDS + OT_ROUNDS) {
        const a = Towers.weakest(s, 'host'), b = Towers.weakest(s, 'guest');
        this.towersOver(a === b ? null : a > b ? 'host' : 'guest', a === b ? 'draw' : 'tiebreak');
        return;
      }
      this.towersStudy();
    }
    this.towersSend();
  }

  towersOver(winner, how) {
    const g = this.game, s = g.battle;
    const loser = winner && (winner === 'host' ? 'guest' : 'host');
    const wn = winner && g[winner].name, ln = loser && g[loser].name;
    const cr = [s.sides.host.crowns, s.sides.guest.crowns];
    const score = winner === 'host' ? cr[0] + '–' + cr[1] : cr[1] + '–' + cr[0];
    const why = {
      king: wn + " knocked down " + ln + "'s king tower.",
      time: 'After ' + ROUNDS + ' rounds the crowns were ' + score + '.',
      overtime: wn + ' took a tower in overtime.',
      tiebreak: 'Still level after the overtime rounds, and ' + ln + "'s weakest tower had less left.",
      draw: "Level on crowns and on tower health. It's a draw.",
      kings: "Both king towers fell at the same moment. It's a draw.",
    }[how];
    g.phase = 'over';
    g.over = { winner, draw: !winner, why, crowns: cr };
    this.stopLoop();
    this.towersSend();
    this.sendState();
  }

  towersSnapshot(mode) {
    const g = this.game;
    return {
      t: 'state',
      phase: g.phase,
      mode,
      modeName: MODES[mode],
      test: !!g.test,
      ms: g.phase === 'countdown' ? Math.max(0, g.deadline - Date.now()) : 0,
      host: { name: g.host.name, char: g.host.char },
      guest: { name: g.guest.name, char: g.guest.char },
      over: g.over,
      towers: {
        stats: {
          host: { asked: g.tq.host.asked, right: g.tq.host.right },
          guest: { asked: g.tq.guest.asked, right: g.tq.guest.right },
        },
      },
    };
  }

  sendTo(role, msg) {
    const payload = JSON.stringify(msg);
    for (const conn of [...this.sockets]) {
      if (conn.role !== role) continue;
      try { conn.ws.send(payload); } catch (e) { this.sockets.delete(conn); }
    }
  }

  startLoop(ms = TICK_MS) {
    if (this.loop) return;
    this.loop = setInterval(() => {
      try { this.tick(); } catch (e) { /* a dropped tick just means a slightly late deadline */ }
    }, ms);
  }

  stopLoop() {
    if (this.loop) { clearInterval(this.loop); this.loop = null; }
  }

  isOnline(role) {
    for (const c of this.sockets) if (c.role === role) return true;
    return false;
  }

  async lobbyLeave(role) {
    const lobby = await this.loadLobby();
    if (!lobby || this.game || lobby.closed) return;
    if (role === 'guest') {
      if (lobby.vsBot) return;
      lobby.guestToken = '';
      lobby.guestReady = false;
      lobby.guestName = '';
      lobby.guestChar = '';
      lobby.code = null;   // the old code was let go when they joined; the host gets a new one
      await this.saveLobby();
      for (const c of [...this.sockets]) if (c.role === 'guest') { this.sockets.delete(c); try { c.ws.close(1000, 'left'); } catch (e) {} }
      this.sendState();
      return;
    }
    lobby.closed = true;
    await this.saveLobby();
    if (lobby.code) {
      codeBook(this.env, lobby.code).fetch('https://code/release', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: lobby.id }),
      }).catch(() => {});
    }
    for (const c of [...this.sockets]) {
      this.sockets.delete(c);
      try { c.ws.send(JSON.stringify({ t: 'closed', name: lobby.hostName })); c.ws.close(1000, 'called off'); } catch (e) {}
    }
  }

  // one player walked out: the match is over for both of them. after a match
  // has already finished it just stops a rematch being offered to nobody
  playerLeft(role) {
    const g = this.game;
    if (!g) return;
    const other = role === 'host' ? 'guest' : 'host';
    if (g.phase === 'over') {
      if (g.over && !g.over.left) { g.over.left = role; this.sendState(); }
      return;
    }
    g.phase = 'over';
    g.over = { winner: other, left: role, why: g[role].name + ' left the game.' };
    g.q = null;
    if (g.chess) { if (g.chess.since) this.chessStop(); g.chess.call = g.over.why; }
    else if (g.sea) g.sea.call = g.over.why;
    else if (g.golf) { g.golf.shot = null; g.golf.after = null; g.golf.call = g.over.why; }
    else if (g.table) { g.table.shot = null; g.table.after = null; g.table.call = g.over.why; }
    this.stopLoop();
    this.sendState();
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
    if (g.mode === 'chess') this.chessTick(g);
    else if (g.mode === 'battleships') this.seaTick(g);
    else if (g.mode === 'towers') this.towersTick(g);
    else if (g.mode === 'golf') this.golfTick(g);
    else this.poolTick(g);
  }

  // role says whose eyes it's for. only battleships keeps secrets per seat
  snapshot(role) {
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
          // a claimed seat only counts while its player is connected
          here: !!(lobby && lobby.guestToken && (lobby.vsBot || this.isOnline('guest'))), char: lobby ? lobby.guestChar : '',
          claimed: !!(lobby && lobby.guestToken),
        },
      };
    }

    if (g.chess) return this.chessSnapshot(mode);
    if (g.sea) return this.seaSnapshot(mode, role);
    if (g.battle) return this.towersSnapshot(mode);
    if (g.golf) return this.golfSnapshot(mode);

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
        // exact, not rounded: the shooter's browser runs its shot from these
        balls: T.balls.map((b) => (b.in ? null : [b.x, b.y])),
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

  chessSnapshot(mode) {
    const g = this.game, C = g.chess, turn = this.chessTurn();
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
      chess: {
        fen: Chess.toFen(C.pos),
        turn,
        colors: C.colors,
        clocks: { host: this.chessLeft('host'), guest: this.chessLeft('guest') },
        running: C.since ? turn : null,
        last: C.last,
        sans: C.sans,
        call: C.call,
        stats: C.stats,
        streak: C.streak,
        hintAt: HINT_STREAK,
        penaltyMs: CHESS_PENALTY_MS,
        // the room only says when the best move is earned; the mover's own
        // browser does the searching, so the room never burns time on it
        hint: g.phase === 'move' && C.streak[turn] >= HINT_STREAK,
        cqResult: C.cqResult,
        penalty: C.penalty,
      },
    };
    // never ship the answer index while the question is still live
    if (g.q && (g.phase === 'cq' || g.phase === 'cqres')) {
      snap.q = g.phase === 'cq'
        ? { text: g.q.text, choices: g.q.choices }
        : { text: g.q.text, choices: g.q.choices, answer: g.q.answer };
    }
    return snap;
  }

  seaSnapshot(mode, role) {
    const g = this.game, S = g.sea;
    const me = role === 'guest' ? 'guest' : 'host', op = me === 'host' ? 'guest' : 'host';
    const mine = S.boards[me], theirs = S.boards[op];
    const theirSunk = Sea.sunkList(theirs.fleet, theirs.shots);
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
      sea: {
        // who fires first stays a secret until both fleets are in
        turn: g.phase === 'place' ? null : S.turn,
        call: S.call,
        ready: S.ready,
        stats: S.stats,
        streak: S.streak,
        streakAt: SEA_STREAK,
        aimMs: SEA_AIM_MS,
        placeMs: SEA_PLACE_MS,
        bqResult: S.bqResult,
        last: S.last,
        reveal: S.reveal,
        mine: {
          fleet: mine.fleet,
          shots: mine.shots.join(''),
          marks: mine.marks.join(''),
          sunk: Sea.sunkList(mine.fleet, mine.shots),
        },
        // their ships stay hidden until they're sunk, or the match is over
        theirs: {
          fleet: theirs.fleet.map((s, i) => (g.phase === 'over' || theirSunk[i] ? s : null)),
          shots: theirs.shots.join(''),
          marks: theirs.marks.join(''),
          sunk: theirSunk,
        },
      },
    };
    // never ship the answer index while the question is still live
    if (g.q && (g.phase === 'bq' || g.phase === 'bqres')) {
      snap.q = g.phase === 'bq'
        ? { text: g.q.text, choices: g.q.choices }
        : { text: g.q.text, choices: g.q.choices, answer: g.q.answer };
    }
    return snap;
  }

  // each seat gets its own copy of the state, because in battleships the two
  // players must never see each other's fleets
  sendState() {
    const made = {};
    for (const conn of [...this.sockets]) {
      const payload = made[conn.role] || (made[conn.role] = JSON.stringify(this.snapshot(conn.role)));
      try { conn.ws.send(payload); } catch (e) { this.sockets.delete(conn); }
    }
  }
}

async function api(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);   // ['api','games', id?, 'ws'?]

  if (parts[1] === 'codes' && parts.length === 3 && request.method === 'GET') {
    if (!/^\d{6}$/.test(parts[2])) return err(404, 'no such code');
    return codeBook(env, parts[2]).fetch('https://code/lookup');
  }

  if (parts[1] !== 'games') return err(404, 'not found');

  if (parts.length === 2 && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const id = randomId(9);
    const room = env.GAMES.get(env.GAMES.idFromName(id));
    const res = await room.fetch('https://room/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: body.name, mode: body.mode, char: body.char, test: body.test, deck: body.deck }),
    });
    const created = await res.json();
    return json({ id, token: created.token }, { status: 201 });
  }

  if (parts.length === 4 && parts[3] === 'code' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const room = env.GAMES.get(env.GAMES.idFromName(parts[2]));
    return room.fetch('https://room/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: parts[2], token: body.token }),
    });
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
