/*
 * Where every question in a match comes from.
 *
 * A game never builds a question itself. It asks its player's feed for the
 * next one, and the feed asks a source. Today the only source is the maths
 * placeholder; a study set will be another source with the same `draw()`.
 *
 * A question is { id, text, choices, answer, diff, why? }. `diff` (0 to 1) and
 * `why` are for the room only. The snapshots build their own { text, choices }
 * objects, so nothing here but text and choices ever reaches a browser, and
 * players never see a difficulty ranking.
 */

const RECENT = 8;     // a question doesn't come back until this many others have

function rnd(n) { return Math.floor(Math.random() * n); }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// placeholder subject: simple mental arithmetic, four choices, distractors
// that sit near the answer so you can't win by eyeballing the odd one out
function mathsQuestion() {
  const adding = Math.random() < 0.6;
  let text, value, diff;
  if (adding) {
    const a = 2 + rnd(12), b = 3 + rnd(12);
    text = a + ' + ' + b;
    value = a + b;
    diff = (a + b - 5) / 25;
  } else {
    const a = 8 + rnd(14), b = 1 + rnd(7);
    text = a + ' − ' + b;
    value = a - b;
    diff = (a - 8) / 13 * 0.5 + b / 7 * 0.5;
  }
  const pool = new Set([value]);
  while (pool.size < 4) {
    const off = (1 + rnd(4)) * (Math.random() < 0.5 ? -1 : 1);
    if (value + off >= 0) pool.add(value + off);
  }
  const choices = shuffle([...pool]);
  return { id: 'm:' + text, text, choices, answer: choices.indexOf(value), diff: Math.max(0, Math.min(1, diff)) };
}

export const mathsSource = { draw: mathsQuestion };

// one per player. Hands out questions from its source, skips ones it served
// a moment ago, and keeps a count of what was shown and how it went (the
// start of the question performance data; nothing stores it yet).
export class Feed {
  constructor(source) {
    this.source = source || mathsSource;
    this.recent = [];
    this.stats = {};     // id → { shown, right }
  }

  next() {
    let q = this.source.draw();
    for (let tries = 0; tries < 6 && this.recent.includes(q.id); tries++) q = this.source.draw();
    this.recent.push(q.id);
    if (this.recent.length > RECENT) this.recent.shift();
    const s = this.stats[q.id] || (this.stats[q.id] = { shown: 0, right: 0 });
    s.shown += 1;
    return q;
  }

  result(q, right) {
    const s = q && this.stats[q.id];
    if (s && right) s.right += 1;
  }
}
