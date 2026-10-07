/**
 * Study Duel — two-player study mini games run on a Durable Object.
 *
 * Each match gets its own GameRoom, which holds the only authoritative copy
 * of the state. Both players hold a WebSocket to that room, so a shot or a
 * ruling lands on both screens at the same moment rather than waiting for a
 * poll.
 *
 * Pool: 8-ball where every shot has to be earned by answering a question
 * first. The room simulates each shot itself (pool.js) and ships both phones
 * the frames to replay.
 *
 * Chess: moves always alternate, so nobody ever gets two in a row. Each move
 * still needs a right answer first, but a wrong one costs time off your chess
 * clock and you get another question. Three right in a row unlocks the best
 * move for as long as the streak lasts. The rules live in public/chess.js,
 * which the browser loads too.
 *
 * Towers: a tower-battle game after Clash Royale. It runs in real time, and
 * both players answer their own questions at once: every right answer is
 * elixir, and elixir is the only way to play cards. The battle itself is in
 * towers.js, and the cards and the arena in public/towers-cards.js.
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
import * as Chess from './public/chess.js';
import * as Towers from './towers.js';
import * as Cards from './public/towers-cards.js';

const QUESTION_MS  = 10000;   // how long each question stays up
const COUNTDOWN_MS = 3200;    // 3 - 2 - 1 before the first question
const TICK_MS      = 200;     // how often the room checks its own deadlines
const NAME_MAX     = 16;
// every mini game gets an entry here; the lobby, test mode and leaving all
// work the same whichever one is picked
const MODES        = { pool: 'Pool', chess: 'Chess', towers: 'Towers' };

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

// ---- Towers ----
// no turns: the battle runs in real time and both players answer their own
// questions at once. elixir only comes from right answers
const TOWERS_TICK_MS   = 100;     // one battle step; both screens get a picture every step
const TOWERS_REG_TICKS = 1800;    // 3:00 of regular time
const TOWERS_OT_TICKS  = 1200;    // up to 2:00 of sudden-death overtime
const TOWERS_RUSH_TICKS = 600;    // the last minute of regular time pays extra
const ELIXIR_RIGHT     = 2;       // elixir for a right answer
const ELIXIR_STREAK    = 1;       // extra once you've got 3 in a row
const ELIXIR_RUSH      = 1;       // extra in the last minute and in overtime
const RIGHT_GAP_MS     = 600;     // after a right answer, the next question comes this soon
const WRONG_LOCK_MS    = 2000;    // after a wrong one, you wait this long

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
        // Towers decks; the stand-in brings a random one
        hostDeck: Cards.cleanDeck(body.deck),
        guestDeck: test ? shuffle(Cards.CARD_KEYS.slice()).slice(0, Cards.DECK_SIZE) : Cards.DEFAULT_DECK.slice(),
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
      lobby.guestDeck = Cards.cleanDeck(msg.deck);
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
    if (msg.t === 'cans') { this.chessAnswer(role, msg.choice); return; }
    if (msg.t === 'move') { this.chessMove(role, msg); return; }
    if (msg.t === 'bans') { this.towersAnswer(role, msg.choice, msg.id); return; }
    if (msg.t === 'play') { this.towersPlay(role, msg); return; }

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
      this.game.bt = 0;
      this.game.botLast = -99;
      this.broadcast(this.snapshot());
      this.towersSend();
      this.startLoop(TOWERS_TICK_MS);
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
      this.broadcast(this.snapshot());
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
    g.q = makeQuestion();
    C.cqResult = null;
    g.phase = 'cq';
    g.deadline = Date.now() + QUESTION_MS;
    this.chessRun();
    if (g.vsBot && this.chessTurn() === 'guest') {
      g.botDueAt = Date.now() + 1500 + rnd(1500);
      g.botChoice = Math.random() < .75 ? g.q.answer : (g.q.answer + 1 + rnd(3)) % 4;
    }
    this.broadcast(this.snapshot());
  }

  chessAnswer(role, choice) {
    const g = this.game;
    if (!g || g.mode !== 'chess' || g.phase !== 'cq' || role !== this.chessTurn()) return;
    const C = g.chess;
    const picked = choice == null ? null : Number(choice);
    const right = picked === g.q.answer;
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
    this.broadcast(this.snapshot());
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
    this.broadcast(this.snapshot());
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
        this.broadcast(this.snapshot());
      } else {
        C.call = (C.cqResult && C.cqResult.choice != null ? 'Wrong answer. ' : 'No answer. ')
          + name + ' loses ' + (CHESS_PENALTY_MS / 1000) + ' seconds. Another question.';
        this.chessAsk();
      }
    }
  }

  // ---- Towers ----
  // the room steps the battle every 100ms and sends each player the shared
  // picture plus their own hand, elixir and question. a question's answer
  // only goes out once it's been answered

  towersQ0() {
    return { q: null, id: 0, state: 'wait', readyAt: 0, last: null, streak: 0, asked: 0, right: 0, botAt: 0, botChoice: 0 };
  }

  towersRush() {
    const g = this.game;
    return g.phase === 'overtime' || (g.phase === 'battle' && g.bt >= TOWERS_REG_TICKS - TOWERS_RUSH_TICKS);
  }

  towersAsk(role) {
    const g = this.game, Q = g.tq[role];
    Q.q = makeQuestion();
    Q.id += 1;
    Q.state = 'ask';
    if (g.vsBot && role === 'guest') {
      Q.botAt = Date.now() + 2000 + rnd(2000);
      Q.botChoice = Math.random() < .75 ? Q.q.answer : (Q.q.answer + 1 + rnd(3)) % 4;
    }
  }

  towersAnswer(role, choice, id) {
    const g = this.game;
    if (!g || g.mode !== 'towers' || (g.phase !== 'battle' && g.phase !== 'overtime')) return;
    const Q = g.tq[role];
    if (Q.state !== 'ask' || (id != null && Number(id) !== Q.id)) return;
    const picked = choice == null ? null : Number(choice);
    const right = picked === Q.q.answer;
    Q.asked += 1;
    let gain = 0;
    if (right) {
      Q.right += 1;
      Q.streak += 1;
      gain = ELIXIR_RIGHT + (Q.streak >= 3 ? ELIXIR_STREAK : 0) + (this.towersRush() ? ELIXIR_RUSH : 0);
      Towers.addElixir(g.battle, role, gain);
      Q.state = 'right';
      Q.readyAt = Date.now() + RIGHT_GAP_MS;
    } else {
      Q.streak = 0;
      Q.state = 'wrong';
      Q.readyAt = Date.now() + WRONG_LOCK_MS;
    }
    Q.last = { id: Q.id, choice: picked, right, gain };
    this.towersSend();
  }

  towersPlay(role, msg) {
    const g = this.game;
    if (!g || g.mode !== 'towers' || (g.phase !== 'battle' && g.phase !== 'overtime')) return;
    const slot = Number(msg.slot);
    if (!(slot >= 0 && slot < 4)) return;
    const side = g.battle.sides[role];
    // the hand only changes when you play, so a mismatch is a stale double tap
    if (msg.card != null && Cards.CARD_KEYS[Number(msg.card)] !== side.hand[slot]) return;
    const why = Towers.play(g.battle, role, slot, Number(msg.x), Number(msg.y));
    if (why) this.sendTo(role, { t: 'bno', why, slot });
  }

  // a player's own question, as they're allowed to see it
  towersQuestion(role) {
    const Q = this.game.tq[role];
    if (!Q.q) return null;
    const out = { id: Q.id, text: Q.q.text, choices: Q.q.choices, state: Q.state, streak: Q.streak };
    if (Q.state !== 'ask' && Q.last && Q.last.id === Q.id) {
      out.answer = Q.q.answer;
      out.choice = Q.last.choice;
      out.gain = Q.last.gain;
      out.wait = Math.max(0, Q.readyAt - Date.now());
    }
    return out;
  }

  towersLeft() {
    const g = this.game;
    if (g.phase === 'countdown') return TOWERS_REG_TICKS * TOWERS_TICK_MS;
    if (g.phase === 'battle') return (TOWERS_REG_TICKS - g.bt) * TOWERS_TICK_MS;
    if (g.phase === 'overtime') return (TOWERS_REG_TICKS + TOWERS_OT_TICKS - g.bt) * TOWERS_TICK_MS;
    return 0;
  }

  towersSend() {
    const g = this.game, s = g.battle;
    const base = {
      t: 'bt', ph: g.phase, tl: Math.max(0, this.towersLeft()), rush: this.towersRush() ? 1 : 0,
      cd: g.phase === 'countdown' ? Math.max(0, g.deadline - Date.now()) : 0,
      st: [g.tq.host.streak, g.tq.guest.streak],
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
      if (now >= g.deadline) {
        g.phase = 'battle';
        this.towersAsk('host');
        this.towersAsk('guest');
        this.broadcast(this.snapshot());
      }
      this.towersSend();
      return;
    }
    const s = g.battle;
    for (const role of ['host', 'guest']) {
      const Q = g.tq[role];
      if (Q.state !== 'ask' && now >= Q.readyAt) this.towersAsk(role);
      else if (g.vsBot && role === 'guest' && Q.state === 'ask' && now >= Q.botAt) this.towersAnswer('guest', Q.botChoice, Q.id);
    }
    // the stand-in plays at most once a second
    if (g.vsBot && g.bt % 5 === 0 && g.bt - g.botLast >= 10) {
      const p = Towers.botPlay(s, 'guest');
      if (p && !Towers.play(s, 'guest', p.slot, p.x, p.y)) g.botLast = g.bt;
    }
    Towers.step(s);
    g.bt += 1;

    const h = s.sides.host.crowns, c = s.sides.guest.crowns;
    if (s.kingDown) { this.towersOver(s.kingDown === 'host' ? 'guest' : 'host', 'king'); return; }
    if (g.phase === 'battle' && g.bt >= TOWERS_REG_TICKS) {
      if (h !== c) { this.towersOver(h > c ? 'host' : 'guest', 'time'); return; }
      g.phase = 'overtime';
      this.broadcast(this.snapshot());
    } else if (g.phase === 'overtime') {
      // sudden death: the first tower to fall settles it
      if (h !== c) { this.towersOver(h > c ? 'host' : 'guest', 'overtime'); return; }
      if (g.bt >= TOWERS_REG_TICKS + TOWERS_OT_TICKS) {
        const a = Towers.weakest(s, 'host'), b = Towers.weakest(s, 'guest');
        this.towersOver(a === b ? null : a > b ? 'host' : 'guest', a === b ? 'draw' : 'tiebreak');
        return;
      }
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
      time: "Time's up with the crowns at " + score + '.',
      overtime: wn + ' took a tower in overtime.',
      tiebreak: "Still level after overtime, and " + ln + "'s weakest tower had less left.",
      draw: "Level on crowns and on tower health. It's a draw.",
    }[how];
    g.phase = 'over';
    g.over = { winner, draw: !winner, why, crowns: cr };
    this.stopLoop();
    this.towersSend();
    this.broadcast(this.snapshot());
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
    if (g.chess) { if (g.chess.since) this.chessStop(); g.chess.call = g.over.why; }
    else if (g.table) { g.table.shot = null; g.table.after = null; g.table.call = g.over.why; }
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
    if (g.mode === 'chess') this.chessTick(g);
    else if (g.mode === 'towers') this.towersTick(g);
    else this.poolTick(g);
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

    if (g.chess) return this.chessSnapshot(mode);
    if (g.battle) return this.towersSnapshot(mode);

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
      body: JSON.stringify({ name: body.name, mode: body.mode, char: body.char, test: body.test, deck: body.deck }),
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
