/**
 * Mini golf for Study Duel: the courses, the ball physics and Tester's shot
 * picker. The room and both browsers load this same file.
 *
 * The courses are top-down and much bigger than a phone screen. The camera
 * follows the ball, and the course starts out hidden: you only see what your
 * ball (or the other player's) has been near. A hole is a grid of TILE-unit
 * squares, drawn as rows of characters:
 *
 *   ' '  nothing: a ball that lands or rolls here is out of bounds
 *   '#'  wall, WALL_H tall: a chip that's high enough sails over it
 *   '.'  turf          ':'  sand: grabs the ball, and kills a landing dead
 *   '~'  water         'o'  a bumper post in the middle of turf
 *   '^' 'v' '<' '>'   a slope, the arrow pointing downhill
 *   'S'  the tee      'H'  the cup
 *
 * Two clubs: the putter rolls the ball along the ground; the wedge chips it
 * up at 45 degrees, so it flies (real projectile motion: it keeps its speed
 * across the ground while gravity takes its height), bounces and then rolls.
 *
 * Like pool.js, simulate() only uses + - * /, Math.sqrt, Math.floor and
 * Math.abs, with no randomness, so every JS engine gets the same bits and
 * the browsers can run a shot themselves and land exactly where the room did.
 */

export const TILE = 32;
export const BALL_R = 5;
export const CUP_R = 8;
export const WALL_H = 14;               // a ball higher than this clears a wall
const POST_R = 8;                       // bumper posts

export const PUTT_MAX = 520;            // units/s off the putter at full power
export const CHIP_MAX = 560;            // and off the wedge, along the line of flight
const LOFT = 0.7071067811865476;        // sin and cos of 45 degrees
const G = 980;                          // gravity, units/s^2
const ROLL = { turf: 190, sand: 760 };  // rolling resistance, units/s^2
const SLOPE = 130;                      // a slope's pull downhill, units/s^2
const WALL_E = 0.72;                    // speed kept off a wall
const POST_E = 1.05;                    // bumpers give a little back
const LAND = {                          // what a landing keeps: speed along the ground, bounce
  turf: { keep: 0.74, bounce: 0.32 },
  sand: { keep: 0.18, bounce: 0 },
};
const SETTLE_VZ = 40;                   // a bounce smaller than this just rolls
const SINK_SPEED = 240;                 // faster than this over the cup and it lips out
const DUNK_SPEED = 330;                 // a chip that lands straight in the cup
const STOP = 3;
const SIM_HZ = 240;
const SIM_MAX_S = 20;
const MARK_EVERY = SIM_HZ / 10;         // where the ball's been, ten times a second, for the fog
export const REVEAL_R = 4.6;            // tiles of course you get to see around the ball
export const MAX_STROKES = 8;           // pick up after this many on one hole
export const FPS = 30;

// ---- the courses ----
// every hole is walled in; the gaps in the walls are water or a drop. par
// assumes a decent mix of putts and the odd chip over trouble
const COURSE = [
  {
    id: 'dogleg', name: 'The Dogleg', par: 3,
    rows: [
      '################',
      '######.........#',
      '#####..........#',
      '#####....H.....#',
      '#####..........#',
      '#####..........#',
      '######...:::...#',
      '#######..:::...#',
      '########.......#',
      '#~~~~~~~#......#',
      '#~~~~~~~#......#',
      '#~~~~~~~#......#',
      '#.......#......#',
      '#..............#',
      '#..............#',
      '#......o.......#',
      '#..............#',
      '#.......########',
      '#.......#       ',
      '#.......#       ',
      '#..:....#       ',
      '#..:....#       ',
      '#.......#       ',
      '#.......#       ',
      '#...S...#       ',
      '#.......#       ',
      '#########       ',
    ],
  },
  {
    id: 'island', name: 'Island Green', par: 3,
    rows: [
      '##################',
      '#~~~~~~~~~~~~~~~~#',
      '#~~~~~~~~~~~~~~~~#',
      '#~~~~~......~~~~~#',
      '#~~~~~..H...~~~~~#',
      '#~~~~~......~~~~~#',
      '#~~~~~~~..~~~~~~~#',
      '#~~~~~~~..~~~~~~~#',
      '#~~~~~~~..~~~~~~~#',
      '#~~~~~~~..~~~~~~~#',
      '#~~~~~~~..~~~~~~~#',
      '#................#',
      '#................#',
      '#..::........::..#',
      '#..::........::..#',
      '#................#',
      '#######....#######',
      '      #....#      ',
      '      #....#      ',
      '      #....#      ',
      '      #....#      ',
      '      #.S..#      ',
      '      #....#      ',
      '      ######      ',
    ],
  },
  {
    id: 'snake', name: 'Sand Snake', par: 4,
    rows: [
      '#################',
      '#...............#',
      '#..H.....::.....#',
      '#........::.....#',
      '#...............#',
      '#...........#####',
      '#...........#    ',
      '#####.......#####',
      '    #...........#',
      '    #...::......#',
      '    #...::......#',
      '    #...........#',
      '#########.......#',
      '#...............#',
      '#...............#',
      '#..::...........#',
      '#..::....########',
      '#........#       ',
      '#..S.....#       ',
      '#........#       ',
      '##########       ',
    ],
  },
  {
    id: 'valley', name: 'The Valley', par: 3,
    rows: [
      '################',
      '#..............#',
      '#......H.......#',
      '#..............#',
      '#....vvvvvv....#',
      '#>>>>vvvvvv<<<<#',
      '#>>>>vvvvvv<<<<#',
      '#>>>>vvvvvv<<<<#',
      '#>>>>vvvvvv<<<<#',
      '#>>>>......<<<<#',
      '#..............#',
      '#..::......::..#',
      '#..::......::..#',
      '#..............#',
      '#..............#',
      '#~~~~~....~~~~~#',
      '#~~~~~....~~~~~#',
      '#..............#',
      '#..............#',
      '#......S.......#',
      '#..............#',
      '################',
    ],
  },
  {
    id: 'bumpers', name: 'Bumper Alley', par: 3,
    rows: [
      '############',
      '#..........#',
      '#....H.....#',
      '#..........#',
      '#..o....o..#',
      '#..........#',
      '#....o.....#',
      '#..........#',
      '#.o....o...#',
      '#..........#',
      '#....o...o.#',
      '#..........#',
      '#..o.......#',
      '#......o...#',
      '#..........#',
      '#.o..o...o.#',
      '#..........#',
      '#...o......#',
      '#.......o..#',
      '#..........#',
      '#..........#',
      '#....S.....#',
      '#..........#',
      '############',
    ],
  },
  {
    id: 'switchback', name: 'Switchback', par: 4,
    rows: [
      '################',
      '#..............#',
      '#...H..........#',
      '#..............#',
      '#..............#',
      '#############..#',
      '#..............#',
      '#..::..........#',
      '#..::..........#',
      '#..#############',
      '#..............#',
      '#..........::..#',
      '#..........::..#',
      '#############..#',
      '#..............#',
      '#..............#',
      '#.....S........#',
      '#..............#',
      '################',
    ],
  },
];

function build(c) {
  const h = c.rows.length, w = c.rows[0].length;
  let tee = null, cup = null;
  const cells = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = c.rows[y][x] || ' ';
      if (ch === 'S') tee = { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
      if (ch === 'H') cup = { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
      cells.push(ch);
    }
  }
  return { id: c.id, name: c.name, par: c.par, w, h, cells: cells.join(''), tee, cup };
}

export const HOLES = COURSE.map(build);
export const HOLE_IDS = HOLES.map((h) => h.id);
export function hole(id) { return HOLES.find((h) => h.id === id) || HOLES[0]; }

export function cellAt(H, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= H.w || ty >= H.h) return ' ';
  return H.cells[ty * H.w + tx];
}
function tileAt(H, x, y) { return cellAt(H, Math.floor(x / TILE), Math.floor(y / TILE)); }

function surface(ch) {
  if (ch === ':') return 'sand';
  if (ch === '~') return 'water';
  if (ch === ' ') return 'out';
  if (ch === '#') return 'wall';
  return 'turf';
}
const DOWNHILL = { '^': [0, -1], 'v': [0, 1], '<': [-1, 0], '>': [1, 0] };
export function slopeOf(ch) { return DOWNHILL[ch] || null; }

const clampN = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Turn a stroke message into exactly what simulate() should run, or null if
 * it isn't one. The room and the player's browser both call this, so the
 * browser's own early run of the shot matches the room's to the bit.
 *   msg  {dx, dy, power, club: 'putt' | 'chip'}
 */
export function shotFrom(msg) {
  let dx = Number(msg.dx), dy = Number(msg.dy);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 0.0001) || !Number.isFinite(len)) return null;
  dx /= len; dy /= len;
  const power = clampN(Number(msg.power) || 0, 0.04, 1);
  const club = msg.club === 'chip' ? 'chip' : 'putt';
  return { dx, dy, power, club };
}

/**
 * Hit the ball from (x, y) and run it until it stops, drops, splashes or goes
 * out. Returns:
 *   frames   [x, y, z] per frame, opts.fps a second (default FPS, 0 for none)
 *   marks    [x, y] ten times a second, for working out what's been seen
 *   end      where the ball finished ({x, y}); for water or out, where it went in
 *   result   'holed' | 'rest' | 'water' | 'out'
 *   secs     how long it ran
 * opts.exact keeps exact positions in the frames instead of tenths.
 */
export function simulate(H, x, y, shot, opts = {}) {
  const speed = (shot.club === 'chip' ? CHIP_MAX : PUTT_MAX) * shot.power;
  let vx, vy, vz, z = 0;
  if (shot.club === 'chip') { vx = shot.dx * speed * LOFT; vy = shot.dy * speed * LOFT; vz = speed * LOFT; }
  else { vx = shot.dx * speed; vy = shot.dy * speed; vz = 0; }
  const dt = 1 / SIM_HZ;
  const fps = opts.fps == null ? FPS : opts.fps;
  const every = fps > 0 ? Math.max(1, Math.round(SIM_HZ / fps)) : 0;
  const exact = !!opts.exact;
  const rec = () => (exact ? [x, y, z] : [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10]);
  const frames = every ? [rec()] : [];
  const marks = [[x, y]];
  let result = 'rest';
  let step = 1;
  const cupX = H.cup.x, cupY = H.cup.y;

  for (; step <= SIM_HZ * SIM_MAX_S; step++) {
    const air = z > 0 || vz > 0;
    if (air) {
      x += vx * dt; y += vy * dt;
      vz -= G * dt; z += vz * dt;
      if (z <= 0) {
        z = 0;
        const ch = tileAt(H, x, y), surf = surface(ch);
        if (surf === 'water' || surf === 'out') { result = surf; break; }
        const cdx = x - cupX, cdy = y - cupY;
        const hs = Math.sqrt(vx * vx + vy * vy);
        if (cdx * cdx + cdy * cdy < CUP_R * CUP_R && hs < DUNK_SPEED) { x = cupX; y = cupY; result = 'holed'; break; }
        const land = surf === 'sand' ? LAND.sand : LAND.turf;
        vx *= land.keep; vy *= land.keep;
        vz = -vz * land.bounce;
        if (vz < SETTLE_VZ) vz = 0;
      }
    } else {
      const ch = tileAt(H, x, y), surf = surface(ch);
      if (surf === 'water' || surf === 'out') { result = surf; break; }
      const sl = slopeOf(ch);
      if (sl) { vx += sl[0] * SLOPE * dt; vy += sl[1] * SLOPE * dt; }
      // the cup draws in a slow ball that's nearly there, the way a real
      // one falls in off the lip
      const cdx = cupX - x, cdy = cupY - y, cd = Math.sqrt(cdx * cdx + cdy * cdy);
      let sp = Math.sqrt(vx * vx + vy * vy);
      if (cd < CUP_R + 8 && cd > 0.001 && sp < 160) {
        const pull = 600 * (1 - cd / (CUP_R + 8)) * dt;
        vx += cdx / cd * pull; vy += cdy / cd * pull;
        sp = Math.sqrt(vx * vx + vy * vy);
      }
      const slow = (surf === 'sand' ? ROLL.sand : ROLL.turf) * dt;
      if (sp <= slow || sp < STOP) {
        vx = 0; vy = 0;
        if (cd < CUP_R) { x = cupX; y = cupY; result = 'holed'; break; }
        // a ball at rest on a slope stays put: the cloth holds it
        break;
      }
      const k = (sp - slow) / sp;
      vx *= k; vy *= k;
      x += vx * dt; y += vy * dt;
      if (cd < CUP_R) {
        if (sp < SINK_SPEED) { x = cupX; y = cupY; result = 'holed'; break; }
        vx *= 0.8; vy *= 0.8;          // too quick: it rattles over the lip
      }
    }

    // walls and bumpers stand WALL_H tall; anything flying higher clears them
    if (z < WALL_H) {
      const tx0 = Math.floor((x - BALL_R) / TILE), tx1 = Math.floor((x + BALL_R) / TILE);
      const ty0 = Math.floor((y - BALL_R) / TILE), ty1 = Math.floor((y + BALL_R) / TILE);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const ch = cellAt(H, tx, ty);
          if (ch === '#') {
            const nx0 = tx * TILE, ny0 = ty * TILE;
            const px = x < nx0 ? nx0 : x > nx0 + TILE ? nx0 + TILE : x;
            const py = y < ny0 ? ny0 : y > ny0 + TILE ? ny0 + TILE : y;
            let ox = x - px, oy = y - py;
            const d2 = ox * ox + oy * oy;
            if (d2 >= BALL_R * BALL_R) continue;
            let d = Math.sqrt(d2), nx, ny;
            if (d < 0.0001) {
              // the centre got inside the wall: back out the shortest way
              const l = x - nx0, r = nx0 + TILE - x, t = y - ny0, b = ny0 + TILE - y;
              const m = Math.min(l, r, t, b);
              nx = m === l ? -1 : m === r ? 1 : 0; ny = m === t ? -1 : m === b ? 1 : 0;
              d = -m;
            } else { nx = ox / d; ny = oy / d; }
            x += nx * (BALL_R - d); y += ny * (BALL_R - d);
            const vn = vx * nx + vy * ny;
            if (vn < 0) { vx -= (1 + WALL_E) * vn * nx; vy -= (1 + WALL_E) * vn * ny; }
          } else if (ch === 'o') {
            const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
            const ox = x - cx, oy = y - cy, d2 = ox * ox + oy * oy, rr = BALL_R + POST_R;
            if (d2 >= rr * rr || d2 === 0) continue;
            const d = Math.sqrt(d2), nx = ox / d, ny = oy / d;
            x = cx + nx * rr; y = cy + ny * rr;
            const vn = vx * nx + vy * ny;
            if (vn < 0) { vx -= (1 + POST_E) * vn * nx; vy -= (1 + POST_E) * vn * ny; }
          }
        }
      }
    }

    if (every && step % every === 0) frames.push(rec());
    if (step % MARK_EVERY === 0) marks.push([x, y]);
  }

  marks.push([x, y]);
  if (every) frames.push(rec());
  return { frames, marks, end: { x, y }, result, secs: Math.min(step, SIM_HZ * SIM_MAX_S) / SIM_HZ };
}

// ---- the fog ----
// seen is one character per tile, '1' once anyone's ball has been near it.
// the room keeps it and the browsers work it out the same way, from the
// same marks
export function freshSeen(H) {
  return reveal(H, '0'.repeat(H.w * H.h), [[H.tee.x, H.tee.y]]);
}

export function reveal(H, seen, points) {
  const out = seen.split('');
  const r = REVEAL_R, rr = r * r;
  for (const [px, py] of points) {
    const cx = px / TILE, cy = py / TILE;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(H.w - 1, Math.floor(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H.h - 1, Math.floor(cy + r));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const dx = tx + 0.5 - cx, dy = ty + 0.5 - cy;
        if (dx * dx + dy * dy <= rr) out[ty * H.w + tx] = '1';
      }
    }
  }
  return out.join('');
}

// ---- Tester ----
// how many tiles a ball would have to roll to reach the cup from each tile,
// going round walls, water and drops
function distanceField(H) {
  const dist = new Array(H.w * H.h).fill(Infinity);
  const ctx = Math.floor(H.cup.x / TILE), cty = Math.floor(H.cup.y / TILE);
  const q = [[ctx, cty]];
  dist[cty * H.w + ctx] = 0;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i], d = dist[y * H.w + x];
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox, ny = y + oy, s = surface(cellAt(H, nx, ny));
      if (s !== 'turf' && s !== 'sand') continue;
      if (dist[ny * H.w + nx] <= d + 1) continue;
      dist[ny * H.w + nx] = d + 1 + (s === 'sand' ? 1 : 0);
      q.push([nx, ny]);
    }
  }
  return dist;
}

const fields = new Map();

/**
 * A reasonable shot from (x, y): try a spread of directions, strengths and
 * both clubs, and keep whichever leaves the ball closest to the cup by the
 * way it would have to roll. Then wobble the aim a little, so Tester misses
 * like a person.
 */
export function botShot(H, x, y, rand = Math.random) {
  if (!fields.has(H.id)) fields.set(H.id, distanceField(H));
  const dist = fields.get(H.id);
  const at = (px, py) => dist[Math.floor(py / TILE) * H.w + Math.floor(px / TILE)];
  let best = null;
  const DIRS = 32;
  // directions round the circle without trig: a 32-gon built by rotating
  let cx = 1, cy = 0;
  const cs = 0.9807852804032304, sn = 0.19509032201612825;
  for (let i = 0; i < DIRS; i++) {
    for (const club of ['putt', 'chip']) {
      for (const power of [0.3, 0.5, 0.7, 0.9]) {
        const shot = { dx: cx, dy: cy, power, club };
        const r = simulate(H, x, y, shot, { fps: 0 });
        let score;
        if (r.result === 'holed') score = -100;
        else if (r.result !== 'rest') score = 1000;
        else score = at(r.end.x, r.end.y) + (club === 'chip' ? 0.3 : 0);
        if (!best || score < best.score) best = { score, ...shot };
      }
    }
    const nx = cx * cs - cy * sn; cy = cx * sn + cy * cs; cx = nx;
  }
  const wob = (rand() - 0.5) * 0.12;
  const dx = best.dx - best.dy * wob, dy = best.dy + best.dx * wob;
  return { dx, dy, power: clampN(best.power + (rand() - 0.5) * 0.08, 0.04, 1), club: best.club };
}
