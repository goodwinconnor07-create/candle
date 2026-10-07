/**
 * Towers: the cards, the arena and the placement rules, shared by the room
 * (towers.js runs the battle) and the browser (draws it, builds decks, and
 * checks a drop before sending it).
 *
 * The arena is measured in tiles: 18 across and 30 long. The host's side is
 * the bottom (y 16 to 30) and the guest's the top (y 0 to 14), with the river
 * between. Each browser turns the arena round so its own side is at the
 * bottom, the way the chess board turns for black.
 */

export const W = 18, H = 30;
export const RIVER_TOP = 14, RIVER_BOT = 16, RIVER_MID = 15;
export const BRIDGES = [3.5, 14.5];
export const BRIDGE_HALF = 1.5;
// how far into the other side you can drop troops once a tower on that lane
// is down: from the river back to where the tower stood
export const POCKET_TOP = 9.5;

// where the host's towers stand; the guest's are the same spots turned round
export const TOWER_SPOTS = [
  { sub: 'king', lane: -1, x: 9, y: 26.5, half: 2 },
  { sub: 'side', lane: 0, x: 3.5, y: 22.5, half: 1.5 },
  { sub: 'side', lane: 1, x: 14.5, y: 22.5, half: 1.5 },
];
export const TOWER_STATS = {
  // ranges are edge to edge, like the troops'
  king: { hp: 4800, dmg: 110, hit: 1.0, range: 7, shotSpeed: 14 },
  side: { hp: 3000, dmg: 100, hit: 0.8, range: 7, shotSpeed: 15 },
};

export const START_ELIXIR = 0, MAX_ELIXIR = 10;
// spells only chip towers: they take this share of a spell's damage
export const TOWER_SPELL = 0.3;

// turn a point round to the other player's view (and back: it's its own inverse)
export const turn = (x, y) => [W - x, H - y];

/**
 * Every card. Troops and buildings fight; spells happen where they land.
 *   cost      elixir to play
 *   count     how many troops one card drops
 *   hp, dmg   per troop; dmg is per hit
 *   hit       seconds between hits
 *   range     tiles between edges when it can hit (under 1 is melee)
 *   speed     tiles a second: 0.75 slow, 1 medium, 1.5 fast, 2 very fast
 *   targets   'ground', 'all' (air too) or 'buildings' (towers and buildings only)
 *   r         size, for bumping into things; mass decides who shoves whom
 *   splash    hits everything within this radius of the target
 *   spin      hits everything within this radius of itself
 *   shot      it throws something (drawn in the browser); else it's melee
 */
export const CARDS = {
  monitor: {
    name: 'Hall Monitor', cost: 3, kind: 'troop', role: 'Tank',
    blurb: 'Sturdy, cheap and stubborn. Parks himself in a lane and won\'t move.',
    count: 1, hp: 1450, dmg: 165, hit: 1.2, range: 0.7, speed: 1.0, targets: 'ground',
    r: 0.5, mass: 6,
  },
  pencils: {
    name: 'Pencil Pushers', cost: 3, kind: 'troop', role: 'Ranged',
    blurb: 'Two sharpshooters who throw pencils at anything, flying or not.',
    count: 2, hp: 290, dmg: 95, hit: 0.9, range: 5, speed: 1.0, targets: 'all',
    r: 0.4, mass: 2, shot: 'pencil', shotSpeed: 12,
  },
  planes: {
    name: 'Paper Planes', cost: 3, kind: 'troop', role: 'Air swarm',
    blurb: 'Three quick paper planes. Ground troops that only hit the ground can\'t touch them.',
    count: 3, air: true, hp: 190, dmg: 85, hit: 1.0, range: 1.6, speed: 1.5, targets: 'all',
    r: 0.4, mass: 1, shot: 'fold', shotSpeed: 14,
  },
  doodles: {
    name: 'Doodles', cost: 3, kind: 'troop', role: 'Swarm',
    blurb: 'Ten scribbles off the back of a notebook. Swarm anything that can\'t hit them all.',
    count: 10, hp: 80, dmg: 75, hit: 1.0, range: 0.4, speed: 1.5, targets: 'ground',
    r: 0.3, mass: 0.5,
  },
  janitor: {
    name: 'Janitor', cost: 4, kind: 'troop', role: 'Splash',
    blurb: 'Spins his mop and hits everything around him. Swarms hate him.',
    count: 1, hp: 1600, dmg: 210, hit: 1.5, range: 0.7, speed: 1.0, targets: 'ground',
    r: 0.55, mass: 7, spin: 2,
  },
  chem: {
    name: 'Chem Whiz', cost: 5, kind: 'troop', role: 'Ranged splash',
    blurb: 'Lobs fizzing flasks that splash everything nearby, in the air or on the ground.',
    count: 1, hp: 700, dmg: 250, hit: 1.4, range: 5.5, speed: 1.0, targets: 'all',
    r: 0.5, mass: 4, shot: 'flask', shotSpeed: 9, splash: 1.5,
  },
  books: {
    name: 'Bookstack', cost: 5, kind: 'troop', role: 'Tower tank',
    blurb: 'A teetering pile of textbooks. Slow, huge, and only interested in towers.',
    count: 1, hp: 3400, dmg: 220, hit: 1.5, range: 0.7, speed: 0.75, targets: 'buildings',
    r: 0.75, mass: 18, sight: 7,
  },
  skater: {
    name: 'Skater', cost: 4, kind: 'troop', role: 'Tower rush',
    blurb: 'Late for class and very fast. Jumps the river and goes straight for towers.',
    count: 1, hp: 1400, dmg: 260, hit: 1.6, range: 0.7, speed: 2.0, targets: 'buildings',
    r: 0.5, mass: 5, jumps: true, sight: 7,
  },
  lantern: {
    name: 'Paper Lantern', cost: 5, kind: 'troop', role: 'Air bomber',
    blurb: 'Floats over to a tower and drops hot wax on it. Leaves a parting gift when popped.',
    count: 1, air: true, hp: 1350, dmg: 700, hit: 3.0, range: 0.3, speed: 1.0, targets: 'buildings',
    r: 0.6, mass: 6, sight: 7, deathDmg: 230, deathR: 2,
  },
  stapler: {
    name: 'Stapler', cost: 3, kind: 'building', role: 'Defence',
    blurb: 'A turret that staples ground troops. Pulls tower-chasers off course. Wears out in 30s.',
    hp: 800, dmg: 130, hit: 0.9, range: 5.5, targets: 'ground',
    r: 1, life: 30, shot: 'staple', shotSpeed: 14,
  },
  quiz: {
    name: 'Pop Quiz', cost: 4, kind: 'spell', role: 'Area damage',
    blurb: 'Lands from your king tower in a burst. Big damage to everything in the circle.',
    radius: 2.5, dmg: 520, knock: 1, travel: 13,
  },
  eraser: {
    name: 'Eraser', cost: 2, kind: 'spell', role: 'Rolling sweep',
    blurb: 'Rolls forward ten tiles, rubbing out ground troops and shoving them back.',
    dmg: 240, roll: 10, rollSpeed: 7, half: 1.8, knock: 1,
  },
  detention: {
    name: 'Detention', cost: 4, kind: 'spell', role: 'Freeze',
    blurb: 'Everyone in the circle stays where they are for 4 seconds. Towers too.',
    radius: 3, dmg: 90, freeze: 4,
  },
  coffee: {
    name: 'Coffee Break', cost: 2, kind: 'spell', role: 'Speed boost',
    blurb: 'Your troops in the circle move and hit 35% faster for as long as it lasts.',
    radius: 4.5, rage: 6,
  },
};

export const CARD_KEYS = Object.keys(CARDS);
// what flies through the air, by number on the wire
export const SHOT_KINDS = ['pencil', 'fold', 'flask', 'staple', 'ember', 'royal', 'quiz', 'eraser'];
export const DEFAULT_DECK = ['monitor', 'pencils', 'planes', 'doodles', 'books', 'chem', 'quiz', 'eraser'];
export const DECK_SIZE = 8;

// a deck from a browser only counts if it's eight different cards we know
export function cleanDeck(deck) {
  if (!Array.isArray(deck)) return DEFAULT_DECK.slice();
  const out = [];
  for (const k of deck) if (CARDS[k] && out.indexOf(k) < 0) out.push(k);
  return out.length === DECK_SIZE ? out : DEFAULT_DECK.slice();
}

/**
 * Can `role` play `key` at (x, y)? Points are in the host's view. `towers`
 * is every tower as { owner, sub, x, y, half, alive }, also in the host's view.
 *
 * Spells go anywhere. Troops and buildings go on your own side, or, once a
 * tower on that lane is down, in the pocket it leaves on their side. Never
 * on top of a standing tower.
 */
export function placeOk(key, role, x, y, towers) {
  const c = CARDS[key];
  if (!c || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (c.kind === 'spell') return x >= 0 && x <= W && y >= 0 && y <= H;
  // look at it from this player's side, so "own side" is always the bottom
  const [mx, my] = role === 'host' ? [x, y] : turn(x, y);
  const pad = c.kind === 'building' ? 1 : 0.5;
  let ok = mx >= pad && mx <= W - pad && my >= RIVER_BOT + pad && my <= H - pad;
  if (!ok && mx >= pad && mx <= W - pad && my >= POCKET_TOP && my <= RIVER_TOP - pad) {
    for (const t of towers) {
      if (t.owner === role || t.sub !== 'side' || t.alive) continue;
      const tx = role === 'host' ? t.x : turn(t.x, t.y)[0];
      if (tx < W / 2 ? mx <= W / 2 : mx >= W / 2) ok = true;
    }
  }
  if (!ok) return false;
  for (const t of towers) {
    if (!t.alive) continue;
    if (Math.abs(x - t.x) < t.half + pad && Math.abs(y - t.y) < t.half + pad) return false;
  }
  return true;
}
