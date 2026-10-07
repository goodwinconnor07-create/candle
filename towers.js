/**
 * Towers: the battle itself. The room steps this ten times a second and
 * sends both browsers a compact picture of it; the browsers only draw.
 *
 * Positions are in tiles in the host's view (see public/towers-cards.js):
 * the host defends the bottom, the guest the top, and the river runs across
 * the middle with a bridge on each lane.
 *
 * How troops think, after Clash Royale:
 *   - Each one goes for the nearest enemy it's allowed to hit within its
 *     sight. With nothing in sight it walks to the nearest enemy tower.
 *   - Once it's swinging at something it stays on it until it dies.
 *   - Ground troops cross the river by a bridge; flyers and the Skater don't
 *     need one.
 *   - Tower-chasers ignore troops altogether, so a building in their path
 *     pulls them off course.
 * Towers shoot the nearest enemy in range. A king tower sleeps until it's
 * hit or loses a side tower.
 */

import * as T from './public/towers-cards.js';

export const TICK = 0.1;           // seconds per step
const RAGE = 1.35;                 // Coffee Break speeds everything up by this much
const SIGHT = 5.5;                 // how far a troop notices enemies, in tiles
const DEPLOY = 1;                  // seconds before a dropped troop can act

const CARD_INDEX = Object.fromEntries(T.CARD_KEYS.map((k, i) => [k, i]));
const SHOT_INDEX = Object.fromEntries(T.SHOT_KINDS.map((k, i) => [k, i]));
const other = (role) => (role === 'host' ? 'guest' : 'host');
const bit = (role) => (role === 'host' ? 0 : 1);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r10 = (n) => Math.round(n * 10);

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newBattle(decks, rand = Math.random) {
  const s = { tick: 0, ents: [], shots: [], zones: [], fx: [], nextId: 1, sides: {}, byId: new Map(), rand, kingDown: null };
  for (const role of ['host', 'guest']) {
    const deck = shuffle(T.cleanDeck(decks[role]), rand);
    s.sides[role] = { crowns: 0, elixir: T.START_ELIXIR, hand: deck.slice(0, 4), next: deck[4], queue: deck.slice(5) };
    for (const spot of T.TOWER_SPOTS) {
      const [x, y] = role === 'host' ? [spot.x, spot.y] : T.turn(spot.x, spot.y);
      const st = T.TOWER_STATS[spot.sub];
      s.ents.push({
        id: s.nextId++, kind: 'tower', sub: spot.sub, owner: role, x, y, r: spot.half, half: spot.half,
        hp: st.hp, maxHp: st.hp, dmg: st.dmg, hit: st.hit, range: st.range, targets: 'all',
        shot: spot.sub === 'king' ? 'royal' : 'ember', shotSpeed: st.shotSpeed, splash: 0, spin: 0,
        air: false, static: true, mass: Infinity, cd: 0, windup: 0, deploy: 0, frozen: 0, rage: 0,
        target: 0, engaged: false, active: spot.sub !== 'king', atk: 0,
      });
    }
  }
  index(s);
  return s;
}

function index(s) {
  s.byId = new Map();
  for (const e of s.ents) s.byId.set(e.id, e);
}

export function towers(s) {
  return s.ents.filter((e) => e.kind === 'tower')
    .map((e) => ({ owner: e.owner, sub: e.sub, x: e.x, y: e.y, half: e.half, alive: e.hp > 0, hp: e.hp }));
}

export function addElixir(s, role, n) {
  const side = s.sides[role];
  side.elixir = Math.min(T.MAX_ELIXIR, side.elixir + n);
}

// ---- playing a card ----

/**
 * Play the card in hand slot `slot` at (x, y). Returns '' when it worked,
 * or why it didn't: 'card', 'elixir' or 'place'.
 */
export function play(s, role, slot, x, y) {
  const side = s.sides[role];
  const key = side.hand[slot];
  const c = T.CARDS[key];
  if (!c) return 'card';
  if (side.elixir + 1e-9 < c.cost) return 'elixir';
  if (!T.placeOk(key, role, x, y, towers(s))) return 'place';
  side.elixir -= c.cost;
  // the played card goes to the back of the queue and the next one comes in
  side.hand[slot] = side.next;
  side.queue.push(key);
  side.next = side.queue.shift();
  if (c.kind === 'spell') cast(s, role, key, x, y);
  else spawn(s, role, key, x, y);
  return '';
}

function formation(n) {
  if (n === 1) return [[0, 0]];
  if (n === 2) return [[-0.55, 0], [0.55, 0]];
  if (n === 3) return [[0, -0.5], [-0.6, 0.4], [0.6, 0.4]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996, rr = 0.38 * Math.sqrt(i + 0.6);
    out.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  return out;
}

function spawn(s, role, key, x, y) {
  const c = T.CARDS[key];
  const flip = role === 'host' ? 1 : -1;
  for (const [ox, oy] of formation(c.count || 1)) {
    const e = {
      id: s.nextId++, kind: c.kind, card: key, owner: role,
      x: clamp(x + ox * flip, c.r, T.W - c.r), y: clamp(y + oy * flip, c.r, T.H - c.r), r: c.r,
      hp: c.hp, maxHp: c.hp, dmg: c.dmg, hit: c.hit, range: c.range, speed: c.speed || 0,
      sight: c.kind === 'building' ? c.range : (c.sight || SIGHT), targets: c.targets,
      air: !!c.air, static: c.kind === 'building', mass: c.kind === 'building' ? Infinity : (c.mass || 4),
      splash: c.splash || 0, spin: c.spin || 0, shot: c.shot || '', shotSpeed: c.shotSpeed || 0,
      jumps: !!c.jumps, windup: Math.min(0.5, c.hit * 0.4), cd: 0, deploy: DEPLOY, frozen: 0, rage: 0,
      target: 0, engaged: false, decay: c.life ? c.hp / c.life : 0,
      deathDmg: c.deathDmg || 0, deathR: c.deathR || 0, atk: 0,
    };
    unwater(e);
    s.ents.push(e);
    s.byId.set(e.id, e);
  }
}

function cast(s, role, key, x, y) {
  const c = T.CARDS[key];
  s.fx.push(['cast', CARD_INDEX[key], r10(x), r10(y), bit(role)]);
  if (key === 'quiz') {
    // flies from your own king tower and lands where you aimed
    const king = s.ents.find((e) => e.kind === 'tower' && e.sub === 'king' && e.owner === role);
    s.shots.push({
      id: s.nextId++, kind: 'quiz', owner: role, x: king.x, y: king.y, target: 0, tx: x, ty: y,
      speed: c.travel, dmg: c.dmg, spell: key,
    });
  } else if (key === 'eraser') {
    s.zones.push({
      id: s.nextId++, kind: 'roll', owner: role, x, y, dir: role === 'host' ? -1 : 1,
      left: c.roll, hit: new Set(),
    });
  } else if (key === 'detention') {
    for (const o of s.ents) {
      if (o.owner === role || o.hp <= 0 || !inCircle(o, x, y, c.radius)) continue;
      damage(s, o, c.dmg, true);
      o.frozen = Math.max(o.frozen, c.freeze);
    }
    s.fx.push(['freeze', r10(x), r10(y), r10(c.radius)]);
  } else if (key === 'coffee') {
    s.zones.push({ id: s.nextId++, kind: 'rage', owner: role, x, y, r: c.radius, left: c.rage });
  }
}

// ---- one step ----

export function step(s) {
  s.tick++;
  s.fx.length = 0;
  index(s);
  zones(s);
  for (const e of s.ents) if (e.hp > 0) think(s, e);
  shots(s);
  separate(s);
  cleanup(s);
}

const inCircle = (o, x, y, r) => Math.hypot(o.x - x, o.y - y) - o.r <= r;

function canHit(a, b) {
  if (a.targets === 'buildings') return b.kind === 'tower' || b.kind === 'building';
  if (a.targets === 'ground') return !b.air;
  return true;
}

// the gap between two things, edge to edge, for towers and troops alike, so
// a tower always outreaches the troops attacking it
function gap(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
}

function think(s, e) {
  if (e.frozen > 0) { e.frozen = Math.max(0, e.frozen - TICK); return; }
  if (e.rage > 0) e.rage = Math.max(0, e.rage - TICK);
  if (e.deploy > 0) { e.deploy = Math.max(0, e.deploy - TICK); return; }
  if (e.decay) { e.hp -= e.decay * TICK; if (e.hp <= 0) { e.hp = 0; return; } }
  if (e.kind === 'tower' && !e.active) return;
  const boost = e.rage > 0 ? RAGE : 1;
  if (e.cd > 0) e.cd -= TICK * boost;
  const t = pickTarget(s, e);
  e.target = t ? t.id : 0;
  if (!t) { e.engaged = false; return; }
  if (gap(e, t) <= e.range) {
    if (!e.engaged) { e.engaged = true; e.cd = Math.max(e.cd, e.windup); }
    if (e.cd <= 0) { attack(s, e, t); e.cd = e.hit; }
  } else {
    e.engaged = false;
    if (e.kind === 'troop') walk(s, e, t, boost);
  }
}

function pickTarget(s, e) {
  const cur = e.target ? s.byId.get(e.target) : null;
  const live = cur && cur.hp > 0 && canHit(e, cur) ? cur : null;
  // swinging at something: stay on it
  if (live && e.engaged && gap(e, live) <= e.range + 0.4) return live;

  if (e.kind !== 'troop') {
    // towers and buildings don't move: the nearest enemy troop or building in range
    let best = null, bd = Infinity;
    for (const o of s.ents) {
      if (o.owner === e.owner || o.hp <= 0 || o.kind === 'tower' || !canHit(e, o)) continue;
      const g = gap(e, o);
      if (g <= e.range && g < bd) { bd = g; best = o; }
    }
    return best;
  }

  // troops: the nearest thing it may hit within sight
  let best = null, bd = Infinity;
  for (const o of s.ents) {
    if (o.owner === e.owner || o.hp <= 0 || !canHit(e, o)) continue;
    const g = gap(e, o);
    if (g <= e.sight && g < bd) { bd = g; best = o; }
  }
  if (best) {
    // don't flick between two targets that are about as close
    if (live && live !== best && gap(e, live) <= e.sight && gap(e, live) < bd + 1) return live;
    return best;
  }
  // nothing in sight: walk to the nearest enemy tower
  let tw = null;
  bd = Infinity;
  for (const o of s.ents) {
    if (o.owner === e.owner || o.hp <= 0 || o.kind !== 'tower') continue;
    const d = Math.hypot(o.x - e.x, o.y - e.y);
    if (d < bd) { bd = d; tw = o; }
  }
  return tw;
}

// ---- moving ----

const sideOf = (y) => (y >= T.RIVER_BOT ? 1 : y <= T.RIVER_TOP ? -1 : 0);
const nearestBridge = (x) => (Math.abs(x - T.BRIDGES[0]) <= Math.abs(x - T.BRIDGES[1]) ? T.BRIDGES[0] : T.BRIDGES[1]);
function bestBridge(x, tx) {
  const [a, b] = T.BRIDGES;
  return Math.abs(x - a) + Math.abs(tx - a) <= Math.abs(x - b) + Math.abs(tx - b) ? a : b;
}

// where to head next on the way to (tx, ty): straight there, unless it's a
// ground troop that has to find a bridge first
function steer(e, tx, ty) {
  if (e.air || e.jumps) return [tx, ty];
  const us = sideOf(e.y);
  const ts = ty >= T.RIVER_MID ? 1 : -1;
  if (us === ts) return [tx, ty];
  const lim = T.BRIDGE_HALF - e.r * 0.6;
  const farY = ts === 1 ? T.RIVER_BOT + 0.3 : T.RIVER_TOP - 0.3;
  if (us === 0) {
    const b = nearestBridge(e.x);
    return [clamp(e.x, b - lim, b + lim), farY];
  }
  const b = bestBridge(e.x, tx);
  const bx = clamp(e.x, b - lim, b + lim);
  const bank = us === 1 ? T.RIVER_BOT : T.RIVER_TOP;
  // lined up with the bridge and close to the water: straight across
  if (Math.abs(e.x - bx) < 0.05 && Math.abs(e.y - bank) < 0.9) return [bx, farY];
  return [bx, bank + us * 0.4];
}

function walk(s, e, t, boost) {
  let [px, py] = steer(e, t.x, t.y);
  let dx = px - e.x, dy = py - e.y, d = Math.hypot(dx, dy);
  // a tower or building in the way that isn't the target: head for a point
  // beside it instead of pressing into it forever (a troop dropped dead
  // behind its own tower would otherwise never get round)
  if (!e.air && d > 1e-6) {
    const hx = dx / d, hy = dy / d;
    for (const o of s.ents) {
      if (!o.static || o.hp <= 0 || o === t) continue;
      const ox = o.x - e.x, oy = o.y - e.y;
      const reach = (o.half || o.r) + e.r + 0.25;
      const ahead = ox * hx + oy * hy;
      if (ahead <= 0 || ahead > reach + 0.6 || ahead > d) continue;
      const side = ox * -hy + oy * hx;            // how far off the line it sits
      if (Math.abs(side) >= reach) continue;
      // pass on the side we're already off to, or toward the middle
      let k = side > 0.05 ? -1 : side < -0.05 ? 1 : 0;
      if (!k) k = (o.x < T.W / 2 ? 1 : -1) * (-hy >= 0 ? 1 : -1) || 1;
      px = o.x + -hy * k * reach * 1.15; py = o.y + hx * k * reach * 1.15;
      dx = px - e.x; dy = py - e.y; d = Math.hypot(dx, dy);
      break;
    }
  }
  if (d < 1e-6) return;
  const len = Math.min(d, e.speed * boost * TICK);
  e.x += (dx / d) * len;
  e.y += (dy / d) * len;
  unwater(e);
}

// ground troops never stand in the water: anything that ends up there (a
// shove, a knockback) goes back to the nearest bank or bridge edge
function unwater(e) {
  if (e.air || e.jumps || e.kind === 'tower') return;
  e.x = clamp(e.x, e.r, T.W - e.r);
  e.y = clamp(e.y, e.r, T.H - e.r);
  if (e.y <= T.RIVER_TOP || e.y >= T.RIVER_BOT) return;
  const b = nearestBridge(e.x), lim = T.BRIDGE_HALF - e.r * 0.5;
  if (Math.abs(e.x - b) <= lim) return;
  const toBridge = Math.abs(e.x - b) - lim, toTop = e.y - T.RIVER_TOP, toBot = T.RIVER_BOT - e.y;
  const m = Math.min(toBridge, toTop, toBot);
  if (m === toBridge) e.x = b + Math.sign(e.x - b) * lim;
  else if (m === toTop) e.y = T.RIVER_TOP;
  else e.y = T.RIVER_BOT;
}

// troops push each other apart, heavier ones less; towers and buildings
// don't budge. flyers only bump flyers
function separate(s) {
  const list = s.ents.filter((e) => e.hp > 0);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if ((a.static && b.static) || a.air !== b.air) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = a.static || b.static ? a.r + b.r : (a.r + b.r) * 0.85;
      if (d >= min) continue;
      if (d < 1e-4) {
        const ang = ((a.id * 7 + b.id * 13) % 628) / 100;
        dx = Math.cos(ang); dy = Math.sin(ang);
      } else { dx /= d; dy /= d; }
      const over = (min - d) * 0.6;
      const ka = a.static ? 0 : b.static ? 1 : b.mass / (a.mass + b.mass);
      const kb = b.static ? 0 : a.static ? 1 : a.mass / (a.mass + b.mass);
      a.x -= dx * over * ka; a.y -= dy * over * ka;
      b.x += dx * over * kb; b.y += dy * over * kb;
    }
  }
  for (const e of list) {
    if (e.static) continue;
    e.x = clamp(e.x, e.r, T.W - e.r);
    e.y = clamp(e.y, e.r, T.H - e.r);
    unwater(e);
  }
}

// ---- fighting ----

function attack(s, e, t) {
  e.atk = s.tick;
  if (e.shot) {
    s.shots.push({
      id: s.nextId++, kind: e.shot, owner: e.owner, x: e.x, y: e.y, target: t.id, tx: t.x, ty: t.y,
      speed: e.shotSpeed, dmg: e.dmg, splash: e.splash, targets: e.targets,
    });
  } else if (e.spin) {
    area(s, e.owner, e.x, e.y, e.spin, e.dmg, e.targets, false);
    s.fx.push(['spin', e.id]);
  } else {
    damage(s, t, e.dmg, false);
  }
}

function damage(s, o, amount, spell) {
  if (o.hp <= 0) return;
  o.hp = Math.max(0, o.hp - (spell && o.kind === 'tower' ? Math.round(amount * T.TOWER_SPELL) : amount));
  if (o.kind === 'tower' && !o.active) wake(s, o);
}

function wake(s, king) {
  if (king.active) return;
  king.active = true;
  s.fx.push(['wake', king.id]);
}

// everything of the other side's within r of (x, y) that `targets` allows
function area(s, owner, x, y, r, dmg, targets, spell, push) {
  for (const o of s.ents) {
    if (o.owner === owner || o.hp <= 0 || !inCircle(o, x, y, r)) continue;
    if (targets === 'ground' && o.air) continue;
    damage(s, o, dmg, spell);
    if (push) knock(o, o.x - x, o.y - y, push);
  }
}

// light troops get shoved; heavy ones, buildings and towers don't
function knock(o, dx, dy, dist) {
  if (o.kind !== 'troop' || o.mass >= 15) return;
  const d = Math.hypot(dx, dy) || 1;
  o.x += (dx / d) * dist;
  o.y += (dy / d) * dist;
  unwater(o);
}

function shots(s) {
  for (const p of s.shots) {
    const t = p.target ? s.byId.get(p.target) : null;
    if (t && t.hp > 0) { p.tx = t.x; p.ty = t.y; }
    const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy), len = p.speed * TICK;
    if (d > len) { p.x += (dx / d) * len; p.y += (dy / d) * len; continue; }
    p.x = p.tx; p.y = p.ty; p.done = true;
    if (p.spell === 'quiz') {
      const c = T.CARDS.quiz;
      area(s, p.owner, p.x, p.y, c.radius, c.dmg, 'all', true, c.knock);
      s.fx.push(['boom', r10(p.x), r10(p.y), r10(c.radius), 0]);
    } else if (p.splash) {
      area(s, p.owner, p.x, p.y, p.splash, p.dmg, p.targets, false);
      s.fx.push(['boom', r10(p.x), r10(p.y), r10(p.splash), 1]);
    } else if (t && t.hp > 0) {
      damage(s, t, p.dmg, false);
    }
  }
  s.shots = s.shots.filter((p) => !p.done);
}

function zones(s) {
  for (const z of s.zones) {
    if (z.kind === 'roll') {
      // the Eraser: rolls toward the other side, hitting each ground thing once
      const c = T.CARDS.eraser, len = c.rollSpeed * TICK;
      z.y += z.dir * len;
      z.left -= len;
      for (const o of s.ents) {
        if (o.owner === z.owner || o.hp <= 0 || o.air || z.hit.has(o.id)) continue;
        if (Math.abs(o.x - z.x) > c.half + o.r || Math.abs(o.y - z.y) > 0.6 + o.r) continue;
        z.hit.add(o.id);
        damage(s, o, c.dmg, true);
        knock(o, 0, z.dir, c.knock);
      }
      if (z.left <= 0 || z.y < 0 || z.y > T.H) z.done = true;
    } else if (z.kind === 'rage') {
      for (const o of s.ents) {
        if (o.owner === z.owner && o.hp > 0 && o.kind !== 'tower' && inCircle(o, z.x, z.y, z.r)) o.rage = Math.max(o.rage, 1);
      }
      z.left -= TICK;
      if (z.left <= 0) z.done = true;
    } else if (z.kind === 'bomb') {
      z.delay -= TICK;
      if (z.delay <= 0) {
        area(s, z.owner, z.x, z.y, z.r, z.dmg, 'ground', false);
        s.fx.push(['boom', r10(z.x), r10(z.y), r10(z.r), 2]);
        z.done = true;
      }
    }
  }
  s.zones = s.zones.filter((z) => !z.done);
}

function cleanup(s) {
  for (const e of s.ents) {
    if (e.hp > 0 || e.gone) continue;
    e.gone = true;
    s.fx.push(['die', e.id, r10(e.x), r10(e.y)]);
    if (e.deathDmg) s.zones.push({ id: s.nextId++, kind: 'bomb', owner: e.owner, x: e.x, y: e.y, r: e.deathR, dmg: e.deathDmg, delay: 0.5 });
    if (e.kind === 'tower') towerDown(s, e);
  }
  // fallen towers stay as rubble; everything else that died goes
  s.ents = s.ents.filter((e) => !e.gone || e.kind === 'tower');
}

function towerDown(s, t) {
  const winner = other(t.owner);
  // side towers that fall with their king don't count again
  if (s.kingDown === t.owner && t.sub !== 'king') return;
  if (t.sub === 'king') {
    // both kings falling in the same step is a draw, not a win for whoever
    // happened to be checked last
    s.kingDown = s.kingDown && s.kingDown !== t.owner ? 'both' : t.owner;
    s.sides[winner].crowns = 3;
    for (const o of s.ents) if (o.kind === 'tower' && o.owner === t.owner) o.hp = 0;
  } else {
    s.sides[winner].crowns = Math.min(3, s.sides[winner].crowns + 1);
    const king = s.ents.find((o) => o.kind === 'tower' && o.sub === 'king' && o.owner === t.owner);
    if (king && king.hp > 0) wake(s, king);
  }
  s.fx.push(['crown', bit(winner), t.id]);
}

// the lowest health among a side's standing towers, for the tiebreak
export function weakest(s, role) {
  let low = Infinity;
  for (const e of s.ents) if (e.kind === 'tower' && e.owner === role && e.hp > 0) low = Math.min(low, e.hp);
  return low === Infinity ? 0 : low;
}

// ---- what the browsers see ----

/**
 * The shared picture of the battle, as small arrays (positions in tenths
 * of a tile):
 *   e   troops and buildings  [id, card, owner, x, y, hp, flags, target]
 *   tw  towers                [id, owner, king, x, y, hp, maxHp, flags]
 *   sh  things in flight      [id, kind, x, y]
 *   zn  coffee circles        [id, x, y, r, owner]
 *   fx  what happened this step
 * flags: 1 dropping in, 2 frozen, 4 boosted, 8 attacked this step, 16 king awake
 */
export function world(s) {
  const e = [], tw = [];
  for (const o of s.ents) {
    const flags = (o.deploy > 0 ? 1 : 0) | (o.frozen > 0 ? 2 : 0) | (o.rage > 0 ? 4 : 0)
      | (o.atk === s.tick ? 8 : 0) | (o.active ? 16 : 0);
    if (o.kind === 'tower') {
      tw.push([o.id, bit(o.owner), o.sub === 'king' ? 1 : 0, r10(o.x), r10(o.y), Math.ceil(o.hp), o.maxHp, flags]);
    } else if (o.hp > 0) {
      e.push([o.id, CARD_INDEX[o.card], bit(o.owner), r10(o.x), r10(o.y), Math.ceil(o.hp), flags, o.target || 0]);
    }
  }
  const sh = s.shots.map((p) => [p.id, SHOT_INDEX[p.kind], r10(p.x), r10(p.y)]);
  const zn = [];
  for (const z of s.zones) {
    if (z.kind === 'roll') sh.push([z.id, SHOT_INDEX.eraser, r10(z.x), r10(z.y)]);
    else if (z.kind === 'rage') zn.push([z.id, r10(z.x), r10(z.y), r10(z.r), bit(z.owner)]);
  }
  return { tk: s.tick, e, tw, sh, zn, fx: s.fx.slice(), cr: [s.sides.host.crowns, s.sides.guest.crowns] };
}

// one player's own hand and elixir; the other side never sees these
export function mine(s, role) {
  const side = s.sides[role];
  return { el: Math.floor(side.elixir * 10) / 10, hand: side.hand.map((k) => CARD_INDEX[k]), next: CARD_INDEX[side.next] };
}

// ---- the test stand-in ----

/**
 * What Tester plays right now, if anything: { slot, x, y } or null.
 * Defends whatever crosses onto its side, spells clumps, and otherwise
 * saves up and pushes a lane.
 */
export function botPlay(s, role, rand = Math.random) {
  const side = s.sides[role];
  if (side.botWant == null) side.botWant = 6 + Math.floor(rand() * 3);
  const hand = side.hand.map((k, i) => ({ k, i, c: T.CARDS[k] })).filter((h) => h.c.cost <= side.elixir);
  if (!hand.length) return null;
  const tw = towers(s);
  // work in Tester's own view, where its side is the bottom
  const view = (x, y) => (role === 'host' ? [x, y] : T.turn(x, y));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const tryAt = (h, mx, my) => {
    for (const [ox, oy] of [[0, 0], [0, 1.5], [1.5, 0], [-1.5, 0], [0, 3], [2.5, 1.5], [-2.5, 1.5]]) {
      const [x, y] = view(clamp(mx + ox, 0.6, T.W - 0.6), clamp(my + oy, 0.6, T.H - 0.6));
      if (T.placeOk(h.k, role, x, y, tw)) return { slot: h.i, x, y };
    }
    return null;
  };

  const foes = s.ents.filter((e) => e.owner !== role && e.hp > 0 && e.kind === 'troop');
  const threats = foes.filter((e) => view(e.x, e.y)[1] > T.RIVER_MID - 1);
  if (threats.length) {
    // the deepest one is the most urgent
    const deep = threats.reduce((a, b) => (view(b.x, b.y)[1] > view(a.x, a.y)[1] ? b : a));
    const [mx, my] = view(deep.x, deep.y);
    const near = threats.filter((t) => Math.hypot(t.x - deep.x, t.y - deep.y) < 2.6);
    const zap = hand.find((h) => h.k === 'quiz' || h.k === 'eraser' || (h.k === 'detention' && near.length >= 4));
    if (zap && near.length >= 3) {
      const cx = near.reduce((a, t) => a + t.x, 0) / near.length, cy = near.reduce((a, t) => a + t.y, 0) / near.length;
      if (zap.k === 'eraser') {
        // roll it from behind the clump, toward the other side
        const [ex, ey] = view(cx, cy);
        const [x, y] = view(ex, Math.min(T.H - 0.5, ey + 2));
        return { slot: zap.i, x, y };
      }
      return { slot: zap.i, x: cx, y: cy };
    }
    const fighters = hand.filter((h) => {
      if (h.c.kind === 'spell') return false;
      if (h.c.kind === 'building') return !deep.air;
      if (h.c.targets === 'buildings') return false;
      return deep.air ? h.c.targets === 'all' : true;
    });
    if (fighters.length) {
      const h = pick(fighters);
      // between the threat and the king tower, leaning toward the middle
      if (h.c.kind === 'building') return tryAt(h, 9, 21);
      return tryAt(h, mx + (9 - mx) * 0.35, Math.max(T.RIVER_BOT + 1, Math.min(my + 2.5, 25)));
    }
    // nothing that can stop it: a Pop Quiz on it, or hit back on the other lane
    const quiz = hand.find((h) => h.k === 'quiz');
    if (quiz && (near.length >= 2 || deep.hp <= T.CARDS.quiz.dmg)) return { slot: quiz.i, x: deep.x, y: deep.y };
    if (side.elixir >= 9) {
      const push = hand.filter((h) => h.c.kind === 'troop');
      if (push.length) return tryAt(pick(push), mx < T.W / 2 ? T.BRIDGES[1] : T.BRIDGES[0], 18.5);
    }
    return null;
  }

  // nothing to defend: once there's enough saved, push a lane
  if (side.elixir < side.botWant) return null;
  const ours = s.ents.filter((e) => e.owner === role && e.hp > 0 && e.kind === 'troop' && view(e.x, e.y)[1] < T.RIVER_MID);
  const coffee = hand.find((h) => h.k === 'coffee');
  if (coffee && ours.length >= 2) {
    const cx = ours.reduce((a, t) => a + t.x, 0) / ours.length, cy = ours.reduce((a, t) => a + t.y, 0) / ours.length;
    side.botWant = 5 + Math.floor(rand() * 4);
    return { slot: coffee.i, x: cx, y: cy };
  }
  const attackers = hand.filter((h) => h.c.kind === 'troop');
  if (!attackers.length) return null;
  side.botWant = 5 + Math.floor(rand() * 4);
  const h = pick(attackers);
  // the lane whose tower is weaker, or a coin toss
  const theirs = tw.filter((t) => t.owner !== role && t.sub === 'side');
  let lane = rand() < 0.5 ? T.BRIDGES[0] : T.BRIDGES[1];
  const alive = theirs.filter((t) => t.alive);
  if (alive.length) {
    const weak = alive.reduce((a, b) => (a.hp <= b.hp ? a : b));
    if (rand() < 0.6) lane = view(weak.x, weak.y)[0];
  }
  const slow = h.c.speed && h.c.speed < 1;
  return tryAt(h, lane + (rand() - 0.5), slow ? 24.5 : 18 + rand() * 2);
}
