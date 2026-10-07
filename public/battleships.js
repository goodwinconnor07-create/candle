/**
 * Battleships rules, shared by the room (worker.js) and the browser, which
 * is why this lives in public/ like chess.js.
 *
 * The sea is 10 by 10. Squares are numbered 0 (A1) to 99 (J10), row by row:
 * the letter is the column and the number is the row. A ship is stored as
 * [origin, vertical], and runs right (or down, if vertical) from its origin.
 * A fleet is one of each ship in FLEET, in that order.
 */

export const SIZE = 10;
export const FLEET = [
  { name: 'Carrier', len: 5 },
  { name: 'Battleship', len: 4 },
  { name: 'Cruiser', len: 3 },
  { name: 'Submarine', len: 3 },
  { name: 'Destroyer', len: 2 },
];
const COLS = 'ABCDEFGHIJ';

export function coord(sq) {
  return COLS[sq % SIZE] + (Math.floor(sq / SIZE) + 1);
}

export function cells(ship, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(ship[0] + i * (ship[1] ? SIZE : 1));
  return out;
}

export function inBounds(ship, len) {
  const at = ship[0];
  if (!Number.isInteger(at) || at < 0 || at >= SIZE * SIZE) return false;
  const x = at % SIZE, y = Math.floor(at / SIZE);
  return ship[1] ? y + len <= SIZE : x + len <= SIZE;
}

// would ship i fit here, leaving the rest of the fleet where it is? ships can
// sit side by side, they just can't overlap
export function fits(fleet, i, ship) {
  const len = FLEET[i].len;
  if (!inBounds(ship, len)) return false;
  const taken = new Set();
  fleet.forEach((s, j) => { if (j !== i && s) cells(s, FLEET[j].len).forEach((c) => taken.add(c)); });
  return cells(ship, len).every((c) => !taken.has(c));
}

// a fleet sent from a browser only counts if it's the full set, on the board,
// with nothing overlapping. returns a tidy copy, or null
export function cleanFleet(raw) {
  if (!Array.isArray(raw) || raw.length !== FLEET.length) return null;
  const out = [];
  for (let i = 0; i < FLEET.length; i++) {
    const s = raw[i];
    if (!Array.isArray(s)) return null;
    out.push([Number(s[0]), !!s[1]]);
  }
  return out.every((s, i) => fits(out, i, s)) ? out : null;
}

export function randomFleet() {
  for (;;) {
    const fleet = [];
    for (let i = 0; i < FLEET.length; i++) {
      for (let tries = 0; tries < 200 && fleet.length === i; tries++) {
        const ship = [Math.floor(Math.random() * SIZE * SIZE), Math.random() < 0.5];
        if (fits(fleet, i, ship)) fleet.push(ship);
      }
    }
    if (fleet.length === FLEET.length) return fleet;
  }
}

// which ship sits on a square, or -1 for open water
export function shipAt(fleet, sq) {
  for (let i = 0; i < fleet.length; i++) {
    if (fleet[i] && cells(fleet[i], FLEET[i].len).includes(sq)) return i;
  }
  return -1;
}

// shots is what's landed on a board so far ('.' nothing, 'o' miss, 'x' hit)
export function sunkList(fleet, shots) {
  return fleet.map((s, i) => cells(s, FLEET[i].len).every((c) => shots[c] === 'x'));
}

// the test stand-in's shot, from what it can see: its own shots, the squares
// it's been told are empty, and the ships it has already sunk. it finishes off
// a ship it has hit before looking for a new one, and hunts on a checkerboard,
// since even the smallest ship covers two squares
export function botFire(shots, marks, sunkCells) {
  const open = (sq) => shots[sq] === '.' && marks[sq] === '.';
  const at = (x, y) => (x >= 0 && x < SIZE && y >= 0 && y < SIZE ? y * SIZE + x : -1);
  const live = (x, y) => { const sq = at(x, y); return sq >= 0 && shots[sq] === 'x' && !sunkCells.has(sq); };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const hits = [];
  for (let sq = 0; sq < SIZE * SIZE; sq++) if (shots[sq] === 'x' && !sunkCells.has(sq)) hits.push(sq);

  if (hits.length) {
    // two hits side by side give away the line, so keep going along it
    const ends = [];
    for (const sq of hits) {
      const x = sq % SIZE, y = Math.floor(sq / SIZE);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (!live(x + dx, y + dy)) continue;
        for (const dir of [-1, 1]) {
          let k = dir < 0 ? 0 : 1;
          while (live(x + dx * k * dir, y + dy * k * dir)) k++;
          const end = at(x + dx * k * dir, y + dy * k * dir);
          if (end >= 0 && open(end)) ends.push(end);
        }
      }
    }
    if (ends.length) return pick(ends);
    const near = [];
    for (const sq of hits) {
      const x = sq % SIZE, y = Math.floor(sq / SIZE);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = at(x + dx, y + dy);
        if (n >= 0 && open(n)) near.push(n);
      }
    }
    if (near.length) return pick(near);
  }

  const all = [];
  for (let sq = 0; sq < SIZE * SIZE; sq++) if (open(sq)) all.push(sq);
  const even = all.filter((sq) => (sq % SIZE + Math.floor(sq / SIZE)) % 2 === 0);
  return pick(even.length ? even : all);
}
