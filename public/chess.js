/**
 * Chess rules and a small engine, shared by the room and the browser.
 *
 * The room (worker.js) uses the rules to check every move, call checkmate and
 * draws, and pick moves for the test stand-in. The browser uses the same file
 * to show legal moves and, on a streak, to search for the best move.
 *
 * A position is { b, turn, castle, ep, half, full }. `b` is 64 squares from
 * a8 (0) to h1 (63), each '' or a FEN letter: upper case is white.
 */

const FILES = 'abcdefgh';
export const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
export const sqIndex = (n) => (8 - Number(n[1])) * 8 + FILES.indexOf(n[0]);
export const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : '');
const other = (c) => (c === 'w' ? 'b' : 'w');
const as = (c, t) => (c === 'w' ? t.toUpperCase() : t);

export function fromFen(fen) {
  const [placement, turn, castle, ep, half, full] = String(fen).split(' ');
  const b = new Array(64).fill('');
  let sq = 0;
  for (const ch of placement) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') sq += Number(ch);
    else b[sq++] = ch;
  }
  return {
    b, turn: turn === 'b' ? 'b' : 'w',
    castle: !castle || castle === '-' ? '' : castle,
    ep: !ep || ep === '-' ? -1 : sqIndex(ep),
    half: Number(half) || 0, full: Number(full) || 1,
  };
}

export function toFen(s) {
  let out = '';
  for (let r = 0; r < 8; r++) {
    let gap = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.b[r * 8 + f];
      if (!p) { gap++; continue; }
      if (gap) { out += gap; gap = 0; }
      out += p;
    }
    if (gap) out += gap;
    if (r < 7) out += '/';
  }
  return out + ' ' + s.turn + ' ' + (s.castle || '-') + ' ' + (s.ep < 0 ? '-' : sqName(s.ep)) + ' ' + s.half + ' ' + s.full;
}

export const start = () => fromFen(START);

// what counts for threefold repetition: the pieces, whose move, and rights.
// the en passant square only counts when the capture is actually there to
// play, the way the rules have it; otherwise every double push would make
// the next position look new
export const posKey = (s) => s.b.join(',') + s.turn + s.castle + (s.ep >= 0 && moves(s).some((m) => m.flag === 'e') ? s.ep : -1);

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const QUEEN = DIAG.concat(ORTH);

// is square `sq` attacked by side `by`?
export function attacked(b, sq, by) {
  const r = sq >> 3, f = sq & 7;
  const P = as(by, 'p'), N = as(by, 'n'), B = as(by, 'b'), R = as(by, 'r'), Q = as(by, 'q'), K = as(by, 'k');
  // a white pawn attacks upwards, so one hitting sq sits a rank below it
  const pr = by === 'w' ? r + 1 : r - 1;
  if (pr >= 0 && pr < 8) {
    if (f > 0 && b[pr * 8 + f - 1] === P) return true;
    if (f < 7 && b[pr * 8 + f + 1] === P) return true;
  }
  for (const [dr, df] of KNIGHT) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === N) return true;
  }
  for (const [dr, df] of KING) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === K) return true;
  }
  for (const [dr, df] of DIAG) {
    for (let rr = r + dr, ff = f + df; rr >= 0 && rr < 8 && ff >= 0 && ff < 8; rr += dr, ff += df) {
      const p = b[rr * 8 + ff];
      if (p) { if (p === B || p === Q) return true; break; }
    }
  }
  for (const [dr, df] of ORTH) {
    for (let rr = r + dr, ff = f + df; rr >= 0 && rr < 8 && ff >= 0 && ff < 8; rr += dr, ff += df) {
      const p = b[rr * 8 + ff];
      if (p) { if (p === R || p === Q) return true; break; }
    }
  }
  return false;
}

export function kingSq(b, c) {
  const K = as(c, 'k');
  for (let i = 0; i < 64; i++) if (b[i] === K) return i;
  return -1;
}

export function inCheck(s, c = s.turn) {
  const k = kingSq(s.b, c);
  return k >= 0 && attacked(s.b, k, other(c));
}

// every move that follows the piece rules, before checking the king is safe.
// `capturesOnly` is for the engine's quiet-down search
function pseudo(s, capturesOnly) {
  const b = s.b, me = s.turn, them = other(me), out = [];
  const add = (from, to, piece, captured, flag) => out.push({ from, to, piece, captured, promo: '', flag });
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p || colorOf(p) !== me) continue;
    const r = sq >> 3, f = sq & 7, t = p.toLowerCase();
    if (t === 'p') {
      const dir = me === 'w' ? -1 : 1, home = me === 'w' ? 6 : 1, last = me === 'w' ? 0 : 7;
      const r1 = r + dir;
      if (r1 < 0 || r1 > 7) continue;
      const pawnTo = (to, captured, flag) => {
        if (r1 === last) for (const pr of ['q', 'r', 'b', 'n']) out.push({ from: sq, to, piece: p, captured, promo: pr, flag });
        else add(sq, to, p, captured, flag);
      };
      const one = r1 * 8 + f;
      if (!b[one] && (!capturesOnly || r1 === last)) {
        pawnTo(one, '', 'n');
        if (!capturesOnly && r === home && !b[one + dir * 8]) add(sq, one + dir * 8, p, '', 'b');
      }
      for (const df of [-1, 1]) {
        const ff = f + df;
        if (ff < 0 || ff > 7) continue;
        const to = r1 * 8 + ff;
        if (b[to] && colorOf(b[to]) === them) pawnTo(to, b[to], 'c');
        else if (to === s.ep) add(sq, to, p, as(them, 'p'), 'e');
      }
      continue;
    }
    if (t === 'n' || t === 'k') {
      for (const [dr, df] of t === 'n' ? KNIGHT : KING) {
        const rr = r + dr, ff = f + df;
        if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
        const to = rr * 8 + ff, q = b[to];
        if (!q) { if (!capturesOnly) add(sq, to, p, '', 'n'); }
        else if (colorOf(q) === them) add(sq, to, p, q, 'c');
      }
      if (t === 'k' && !capturesOnly && s.castle) {
        const home = me === 'w' ? 60 : 4;
        if (sq === home && !attacked(b, home, them)) {
          const R = as(me, 'r');
          if (s.castle.includes(as(me, 'k')) && b[home + 3] === R && !b[home + 1] && !b[home + 2]
              && !attacked(b, home + 1, them) && !attacked(b, home + 2, them)) {
            add(sq, home + 2, p, '', 'k');
          }
          if (s.castle.includes(as(me, 'q')) && b[home - 4] === R && !b[home - 1] && !b[home - 2] && !b[home - 3]
              && !attacked(b, home - 1, them) && !attacked(b, home - 2, them)) {
            add(sq, home - 2, p, '', 'q');
          }
        }
      }
      continue;
    }
    for (const [dr, df] of t === 'b' ? DIAG : t === 'r' ? ORTH : QUEEN) {
      for (let rr = r + dr, ff = f + df; rr >= 0 && rr < 8 && ff >= 0 && ff < 8; rr += dr, ff += df) {
        const to = rr * 8 + ff, q = b[to];
        if (!q) { if (!capturesOnly) add(sq, to, p, '', 'n'); continue; }
        if (colorOf(q) === them) add(sq, to, p, q, 'c');
        break;
      }
    }
  }
  return out;
}

const CORNER_RIGHT = { 63: 'K', 56: 'Q', 7: 'k', 0: 'q' };

export function make(s, m) {
  const b = s.b.slice(), me = s.turn;
  b[m.to] = m.promo ? as(me, m.promo) : m.piece;
  b[m.from] = '';
  if (m.flag === 'e') b[m.to + (me === 'w' ? 8 : -8)] = '';
  if (m.flag === 'k') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = ''; }
  if (m.flag === 'q') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = ''; }
  let castle = s.castle;
  if (castle) {
    if (m.piece === 'K') castle = castle.replace(/[KQ]/g, '');
    else if (m.piece === 'k') castle = castle.replace(/[kq]/g, '');
    if (CORNER_RIGHT[m.from]) castle = castle.replace(CORNER_RIGHT[m.from], '');
    if (CORNER_RIGHT[m.to]) castle = castle.replace(CORNER_RIGHT[m.to], '');
  }
  const pawn = m.piece === 'P' || m.piece === 'p';
  return {
    b, turn: other(me), castle,
    ep: m.flag === 'b' ? (m.from + m.to) / 2 : -1,
    half: pawn || m.captured ? 0 : s.half + 1,
    full: s.full + (me === 'b' ? 1 : 0),
  };
}

// a move is legal if it doesn't leave your own king attacked
function legal(s, list) {
  const me = s.turn, them = other(me), out = [];
  for (const m of list) {
    const n = make(s, m);
    if (!attacked(n.b, kingSq(n.b, me), them)) out.push(m);
  }
  return out;
}

export const moves = (s) => legal(s, pseudo(s, false));

export const uci = (m) => sqName(m.from) + sqName(m.to) + (m.promo || '');

export function san(s, m, all = moves(s)) {
  let out;
  if (m.flag === 'k') out = 'O-O';
  else if (m.flag === 'q') out = 'O-O-O';
  else {
    const t = m.piece.toUpperCase();
    if (t === 'P') {
      out = (m.captured ? FILES[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
    } else {
      const twins = all.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
      let dis = '';
      if (twins.length) {
        if (!twins.some((o) => (o.from & 7) === (m.from & 7))) dis = FILES[m.from & 7];
        else if (!twins.some((o) => (o.from >> 3) === (m.from >> 3))) dis = String(8 - (m.from >> 3));
        else dis = sqName(m.from);
      }
      out = t + dis + (m.captured ? 'x' : '') + sqName(m.to);
    }
  }
  const n = make(s, m);
  if (inCheck(n)) out += moves(n).length ? '+' : '#';
  return out;
}

// can side `c` still mate with what it has? a lone king, or a king and one
// knight or bishop, can't. used for draws and for running out of time
export function canMate(b, c) {
  let minors = 0;
  for (const p of b) {
    if (!p || colorOf(p) !== c) continue;
    const t = p.toLowerCase();
    if (t === 'p' || t === 'r' || t === 'q') return true;
    if (t === 'n' || t === 'b') minors++;
  }
  return minors >= 2;
}

// null while the game goes on, otherwise why it ended. `keys` is every
// position so far (posKey), for threefold repetition
export function status(s, keys) {
  if (!moves(s).length) return inCheck(s) ? 'checkmate' : 'stalemate';
  if (!canMate(s.b, 'w') && !canMate(s.b, 'b')) return 'material';
  if (s.half >= 100) return 'fifty';
  if (keys) {
    const k = posKey(s);
    let seen = 0;
    for (const x of keys) if (x === k) seen++;
    if (seen >= 3) return 'repetition';
  }
  return null;
}

// ---- engine ----
// a plain alpha-beta search with piece-square tables. strong enough to find
// tactics a casual player misses, small enough to live in this file

const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

// from white's side, a8 first. black reads them mirrored
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  kEnd: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
};

// score from the side to move's point of view
function evaluate(s) {
  const b = s.b;
  let heavy = 0;
  for (const p of b) if (p) { const t = p.toLowerCase(); if (t !== 'p' && t !== 'k') heavy += VALUE[t]; }
  const endgame = heavy <= 1600;
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p) continue;
    const white = p === p.toUpperCase(), t = p.toLowerCase();
    const table = t === 'k' && endgame ? PST.kEnd : PST[t];
    const v = VALUE[t] + table[white ? i : i ^ 56];
    score += white ? v : -v;
  }
  return s.turn === 'w' ? score : -score;
}

// captures first, biggest victim by smallest attacker
const order = (m) => (m.captured ? 10 * VALUE[m.captured.toLowerCase()] - VALUE[m.piece.toLowerCase()] + 1000 : 0)
  + (m.promo ? VALUE[m.promo] : 0);
const byOrder = (a, b) => order(b) - order(a);

class Stop extends Error {}

/**
 * Best move for the side to move. `ms` caps the time (browser only: inside a
 * Worker the clock doesn't move while code runs, so the room passes `nodes`
 * instead). Returns { move, san, score, depth, mate } or null if there's no
 * legal move.
 */
export function bestMove(s, opts = {}) {
  const maxDepth = opts.depth || 64;
  const maxNodes = opts.nodes || Infinity;
  const until = opts.ms ? Date.now() + opts.ms : Infinity;
  let nodes = 0;

  const tick = () => {
    nodes++;
    if (nodes > maxNodes || ((nodes & 1023) === 0 && Date.now() > until)) throw new Stop();
  };

  function quiet(pos, alpha, beta, ply) {
    tick();
    const stand = evaluate(pos);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply > 12) return stand;
    const list = legal(pos, pseudo(pos, true)).sort(byOrder);
    for (const m of list) {
      const v = -quiet(make(pos, m), -beta, -alpha, ply + 1);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function search(pos, depth, alpha, beta, ply) {
    tick();
    const list = moves(pos);
    if (!list.length) return inCheck(pos) ? -MATE + ply : 0;
    if (pos.half >= 100) return 0;
    if (depth <= 0) return quiet(pos, alpha, beta, ply);
    list.sort(byOrder);
    let best = -Infinity;
    for (const m of list) {
      const v = -search(make(pos, m), depth - 1, -beta, -alpha, ply + 1);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  const all = moves(s);
  if (!all.length) return null;
  let root = all.slice().sort(byOrder);
  let found = { move: root[0], score: 0, depth: 0 };
  for (let depth = 1; depth <= maxDepth; depth++) {
    const scored = [];
    let alpha = -Infinity;
    try {
      for (const m of root) {
        const v = -search(make(s, m), depth - 1, -Infinity, -alpha, 1);
        scored.push({ m, v });
        if (v > alpha) alpha = v;
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      // a cut-short pass only counts if the move it liked most was searched
      // in full, which it was if that move beat the last pass's choice
      const top = scored.reduce((a, x) => (!a || x.v > a.v ? x : a), null);
      if (top && top.m !== found.move && top.v > found.score) found = { move: top.m, score: top.v, depth };
      break;
    }
    scored.sort((a, b) => b.v - a.v);
    root = scored.map((x) => x.m);
    found = { move: scored[0].m, score: scored[0].v, depth };
    if (Math.abs(found.score) > MATE - 1000) break;   // a forced mate either way won't get better
  }
  const mate = Math.abs(found.score) > MATE - 1000
    ? Math.sign(found.score) * Math.ceil((MATE - Math.abs(found.score)) / 2) : 0;
  return { move: found.move, san: san(s, found.move, all), score: found.score, depth: found.depth, mate };
}

// the test stand-in: looks a move or two ahead, and now and then just plays
// something, so it's beatable
export function botMove(s) {
  const all = moves(s);
  if (!all.length) return null;
  if (Math.random() < 0.25) return all[Math.floor(Math.random() * all.length)];
  const r = bestMove(s, { depth: 2, nodes: 4000 });
  return r ? r.move : all[0];
}
