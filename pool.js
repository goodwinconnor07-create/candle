/**
 * Pool table physics and 8-ball rules for Study Duel's pool mode.
 *
 * The room runs every shot here and is the only authority on where the balls
 * end up. Browsers never simulate: they replay the frames a shot sends back
 * (30 a second), then snap to the final layout. That keeps two phones from
 * ever disagreeing about whether a ball dropped.
 *
 * The table is portrait, like iMessage pool: x runs across (0..PW), y runs
 * down the length (0..PL). The rack sits at the top, the break comes from the
 * bottom. Ball 0 is the cue ball; 1-7 solids, 8 the black, 9-15 stripes.
 */

export const PW = 500;
export const PL = 1000;
export const BALL_R = 14;
export const HEAD_Y = 750;              // the break is played from below this line
export const FOOT_Y = 250;              // apex of the rack
export const CUE_SPOT = [PW / 2, 830];

const CORNER_GAP = 39;                  // how far each corner pocket's mouth runs along the rail
const SIDE_GAP = 29;                    // half-width of a side pocket's mouth
const CORNER_CAPTURE = 37;              // a ball whose centre gets this close to a pocket drops
const SIDE_CAPTURE = 29;

export const POCKETS = [
  [0, 0, CORNER_CAPTURE], [PW, 0, CORNER_CAPTURE],
  [0, PL / 2, SIDE_CAPTURE], [PW, PL / 2, SIDE_CAPTURE],
  [0, PL, CORNER_CAPTURE], [PW, PL, CORNER_CAPTURE],
];

// the knuckles where each rail ends at a pocket mouth. a ball that clips one
// bounces off it rather than sliding through the corner of the cushion
const JAWS = [
  [0, CORNER_GAP], [CORNER_GAP, 0], [PW - CORNER_GAP, 0], [PW, CORNER_GAP],
  [0, PL / 2 - SIDE_GAP], [0, PL / 2 + SIDE_GAP], [PW, PL / 2 - SIDE_GAP], [PW, PL / 2 + SIDE_GAP],
  [0, PL - CORNER_GAP], [CORNER_GAP, PL], [PW - CORNER_GAP, PL], [PW, PL - CORNER_GAP],
];

export const MAX_SPEED = 2600;          // table units per second at full power
const ROLL_DECEL = 300;                 // constant rolling resistance, units/s^2
const DRAG = 0.15;                      // extra slow-down that scales with speed, 1/s
const RAIL_E = 0.78;                    // how much speed survives a cushion
const BALL_E = 0.97;                    // and a ball-on-ball hit
const STOP_SPEED = 3;
const SIM_HZ = 480;                     // small steps so a full-power ball can't skip through another
export const FPS = 30;
const FRAME_EVERY = SIM_HZ / FPS;
const SIM_MAX_S = 14;

// spin is set by where the cue strikes the ball: x is side spin (+ = right),
// y is top/back (+ = top). Kept to a simple, readable model:
//   top/back  → on the cue ball's first hit it follows through or draws back
//   side      → each cushion it touches nudges it sideways, fading as it goes
// and all of it wears off the longer the ball rolls before it gets used.
const FOLLOW = 0.7;                     // share of impact speed added along the line of travel
const ENGLISH = 0.3;                    // share of speed added along a cushion per unit of side spin
const SPIN_FADE = 0.7;                  // per second
export const SPIN_MAX = 0.85;           // past this the cue would miss the ball

export function groupOf(n) {
  if (n >= 1 && n <= 7) return 'solids';
  if (n >= 9 && n <= 15) return 'stripes';
  return null;
}

export function remaining(balls, group) {
  let left = 0;
  for (let n = 1; n <= 15; n++) if (groupOf(n) === group && !balls[n].in) left++;
  return left;
}

function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// a standard rack: 8 in the middle of the third row, one solid and one stripe
// on the back corners, everything else shuffled
export function rack(rand = Math.random) {
  const slots = [];
  const rowStep = BALL_R * 2 * 0.8660254037844386 + 0.2;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j <= i; j++) {
      slots.push({ i, j, x: PW / 2 + (j - i / 2) * (BALL_R * 2 + 0.2), y: FOOT_Y - i * rowStep });
    }
  }
  const at = (i, j) => slots.find((s) => s.i === i && s.j === j);
  const balls = [];
  balls[0] = { x: CUE_SPOT[0], y: CUE_SPOT[1], in: false };

  const solids = shuffled([1, 2, 3, 4, 5, 6, 7], rand);
  const stripes = shuffled([9, 10, 11, 12, 13, 14, 15], rand);
  const left = rand() < 0.5 ? solids.pop() : stripes.pop();
  const right = groupOf(left) === 'solids' ? stripes.pop() : solids.pop();
  const fixed = new Map([[at(2, 1), 8], [at(4, 0), left], [at(4, 4), right]]);
  const rest = shuffled(solids.concat(stripes), rand);
  for (const s of slots) {
    const n = fixed.has(s) ? fixed.get(s) : rest.pop();
    balls[n] = { x: s.x, y: s.y, in: false };
  }
  return balls;
}

// can the cue ball be dropped here when someone has ball in hand?
export function placeOk(balls, x, y, kitchen) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < BALL_R || x > PW - BALL_R || y < BALL_R || y > PL - BALL_R) return false;
  if (kitchen && y < HEAD_Y) return false;
  for (let n = 1; n <= 15; n++) {
    const b = balls[n];
    if (b.in) continue;
    const dx = b.x - x, dy = b.y - y;
    if (dx * dx + dy * dy < (BALL_R * 2) * (BALL_R * 2)) return false;
  }
  return true;
}

// put the 8 back on the foot spot, or the nearest free point above it
export function respot(balls, n) {
  for (let y = FOOT_Y; y > BALL_R; y -= 2) {
    let clear = true;
    for (let m = 0; m <= 15; m++) {
      if (m === n || balls[m].in) continue;
      const dx = balls[m].x - PW / 2, dy = balls[m].y - y;
      if (dx * dx + dy * dy < (BALL_R * 2) * (BALL_R * 2)) { clear = false; break; }
    }
    if (clear) { balls[n] = { x: PW / 2, y, in: false }; return; }
  }
  balls[n] = { x: PW / 2, y: FOOT_Y, in: false };
}

function inSideRail(y) {
  return (y > CORNER_GAP && y < PL / 2 - SIDE_GAP) || (y > PL / 2 + SIDE_GAP && y < PL - CORNER_GAP);
}
function inEndRail(x) {
  return x > CORNER_GAP && x < PW - CORNER_GAP;
}

// one frame: 16 balls as a flat [x0, y0, x1, y1, ...] list of whole numbers,
// with -1, -1 for a ball that's already down
function frameOf(b) {
  const f = new Array(32);
  for (let n = 0; n < 16; n++) {
    if (b[n].in) { f[n * 2] = -1; f[n * 2 + 1] = -1; }
    else { f[n * 2] = Math.round(b[n].x); f[n * 2 + 1] = Math.round(b[n].y); }
  }
  return f;
}

/**
 * Strike the cue ball along (dx, dy) — a unit vector — at `speed`, and run
 * the table until everything stops. Returns the final layout, the frames to
 * replay, every ball that dropped in the order it dropped, and the first
 * object ball the cue ball touched (null if it touched nothing).
 */
export function simulate(start, dx, dy, speed, spin = { x: 0, y: 0 }) {
  const b = start.map((o) => ({ x: o.x, y: o.y, vx: 0, vy: 0, in: o.in }));
  let side = spin.x || 0, top = spin.y || 0;
  b[0].vx = dx * speed;
  b[0].vy = dy * speed;
  const dt = 1 / SIM_HZ;
  const minD2 = (BALL_R * 2) * (BALL_R * 2);
  const frames = [frameOf(b)];
  const potted = [];
  let firstHit = null;

  for (let step = 1; step <= SIM_HZ * SIM_MAX_S; step++) {
    const fade = 1 - SPIN_FADE * dt;
    side *= fade; top *= fade;
    for (const p of b) {
      if (p.in || (p.vx === 0 && p.vy === 0)) continue;
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const slow = (ROLL_DECEL + DRAG * sp) * dt;
      if (sp <= slow || sp < STOP_SPEED) { p.vx = 0; p.vy = 0; continue; }
      const k = (sp - slow) / sp;
      p.vx *= k;
      p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    for (let i = 0; i < 16; i++) {
      const a = b[i];
      if (a.in) continue;
      for (let j = i + 1; j < 16; j++) {
        const c = b[j];
        if (c.in) continue;
        const ox = c.x - a.x, oy = c.y - a.y;
        const d2 = ox * ox + oy * oy;
        if (d2 >= minD2 || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = ox / d, ny = oy / d;
        const push = (BALL_R * 2 - d) / 2;
        a.x -= nx * push; a.y -= ny * push;
        c.x += nx * push; c.y += ny * push;
        const closing = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
        if (closing <= 0) continue;
        const cueFirst = firstHit === null && i === 0;
        const ux = a.vx, uy = a.vy;
        const j2 = closing * (1 + BALL_E) / 2;
        a.vx -= j2 * nx; a.vy -= j2 * ny;
        c.vx += j2 * nx; c.vy += j2 * ny;
        if (cueFirst) {
          firstHit = j;
          // follow or draw: push the cue ball on (or back) along the line it
          // was travelling, scaled by how fast it arrived
          a.vx += ux * top * FOLLOW;
          a.vy += uy * top * FOLLOW;
          top = 0;
        }
      }
    }

    for (let n = 0; n < 16; n++) {
      const p = b[n];
      if (p.in) continue;

      // rn = the cushion's normal pointing back into the table, if one was hit
      let rnx = 0, rny = 0;
      if (p.x < BALL_R && inSideRail(p.y)) { p.x = BALL_R; if (p.vx < 0) { p.vx = -p.vx * RAIL_E; rnx = 1; } }
      if (p.x > PW - BALL_R && inSideRail(p.y)) { p.x = PW - BALL_R; if (p.vx > 0) { p.vx = -p.vx * RAIL_E; rnx = -1; } }
      if (p.y < BALL_R && inEndRail(p.x)) { p.y = BALL_R; if (p.vy < 0) { p.vy = -p.vy * RAIL_E; rny = 1; } }
      if (p.y > PL - BALL_R && inEndRail(p.x)) { p.y = PL - BALL_R; if (p.vy > 0) { p.vy = -p.vy * RAIL_E; rny = -1; } }
      if (n === 0 && side !== 0 && (rnx || rny)) {
        // side spin grips the cushion and throws the ball along it. right
        // spin turns the same way whichever way it's travelling, so the
        // push is fixed to the cushion, not to the shot
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        p.vx += rny * side * ENGLISH * sp;
        p.vy += -rnx * side * ENGLISH * sp;
        side *= 0.5;
      }

      for (const [jx, jy] of JAWS) {
        const ox = p.x - jx, oy = p.y - jy;
        const d2 = ox * ox + oy * oy;
        if (d2 >= BALL_R * BALL_R || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = ox / d, ny = oy / d;
        p.x = jx + nx * BALL_R;
        p.y = jy + ny * BALL_R;
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) { p.vx -= (1 + RAIL_E) * vn * nx; p.vy -= (1 + RAIL_E) * vn * ny; }
      }

      let drop = p.x < -BALL_R || p.x > PW + BALL_R || p.y < -BALL_R || p.y > PL + BALL_R;
      for (const [px, py, cap] of POCKETS) {
        const ox = p.x - px, oy = p.y - py;
        if (ox * ox + oy * oy < cap * cap) { drop = true; break; }
      }
      if (drop) { p.in = true; p.vx = 0; p.vy = 0; potted.push(n); }
    }

    if (step % FRAME_EVERY === 0) frames.push(frameOf(b));
    let moving = false;
    for (const p of b) if (!p.in && (p.vx !== 0 || p.vy !== 0)) { moving = true; break; }
    if (!moving) break;
  }

  frames.push(frameOf(b));
  return {
    balls: b.map((p) => ({ x: p.x, y: p.y, in: p.in })),
    frames,
    potted,
    firstHit,
  };
}

/**
 * Rule on a finished shot under standard 8-ball. `pre` is the table before
 * the shot ({balls, groups, broken}); `sim` is what simulate() returned.
 *
 * Returns who shoots next and why, so the room only has to apply it and put
 * names to it:
 *   foul      ''  or a short reason ('scratch', 'no contact', 'hit the 12 first')
 *   win       null, or the role that just won the game
 *   groups    the groups after this shot (assigned on the first legal pot)
 *   next      'same' or 'other'
 *   respot8   true if the 8 went down on the break and needs putting back
 */
export function judgeShot(pre, sim, shooter) {
  const other = shooter === 'host' ? 'guest' : 'host';
  const groups = { ...pre.groups };
  const mine = groups[shooter];
  const isBreak = !pre.broken;
  const onEight = !!mine && remaining(pre.balls, mine) === 0;
  const objects = sim.potted.filter((n) => n !== 0);
  const scratch = sim.potted.includes(0);
  const eightDown = objects.includes(8);

  let foul = '';
  if (sim.firstHit == null) foul = 'no contact';
  else if (!isBreak) {
    if (onEight) { if (sim.firstHit !== 8) foul = 'hit the ' + sim.firstHit + ' first'; }
    else if (mine) { if (groupOf(sim.firstHit) !== mine) foul = 'hit the ' + sim.firstHit + ' first'; }
    else if (sim.firstHit === 8) foul = 'hit the 8 first';
  }
  if (scratch) foul = 'scratch';

  const base = { foul, groups, objects, assigned: null, respot8: false, win: null, winWhy: '' };

  if (eightDown && !isBreak) {
    if (onEight && !foul) return { ...base, win: shooter, winWhy: 'cleared the table and sank the 8', next: 'same' };
    return { ...base, win: other, winWhy: onEight ? 'sank the 8 on a foul' : 'sank the 8 too early', next: 'other' };
  }

  if (!isBreak && !mine && !foul) {
    const firstObj = objects.find((n) => n !== 8);
    if (firstObj) {
      groups[shooter] = groupOf(firstObj);
      groups[other] = groups[shooter] === 'solids' ? 'stripes' : 'solids';
      base.assigned = groups[shooter];
    }
  }

  const myNow = groups[shooter];
  const keptGoing = isBreak
    ? objects.length > 0
    : !!myNow && objects.some((n) => groupOf(n) === myNow);

  return {
    ...base,
    respot8: isBreak && eightDown,
    next: foul ? 'other' : (keptGoing ? 'same' : 'other'),
  };
}
