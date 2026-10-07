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

import { DEFAULT_TEMPLATES, squash } from './generate.js';

const RECENT = 8;     // a question doesn't come back until this many others have
const ENGINE_SHARE = 1 / 3;   // how often a study set's question is built by the local engine

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

export const mathsSource = { name: 'Quick maths', draw: mathsQuestion };

// ---- study sets ----
// A study set's questions come from two places: the core questions the API
// wrote, dealt like a shuffled deck so none comes back until the rest have
// been out, and the local engine, which fills the set's wording templates
// from its facts. The engine costs nothing and never runs out.

const pick = arr => arr[rnd(arr.length)];
const tidyVal = v => String(v).trim().replace(/[\s.;:,]+$/, '');

// three different wrong answers from `pool`, none equal to `right`
function wrongOnes(pool, right) {
  const seen = new Set([squash(right)]);
  const out = [];
  for (const v of shuffle(pool.slice())) {
    const k = squash(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(tidyVal(v));
    if (out.length === 3) break;
  }
  return out.length === 3 ? out : null;
}

function fill(template, slot, value) {
  return template.split('{' + slot + '}').join(tidyVal(value));
}

function asked(id, text, right, wrong) {
  const choices = shuffle([tidyVal(right), ...wrong]);
  return { id, text, choices, answer: choices.indexOf(tidyVal(right)), diff: 0.3, why: null };
}

// the makers the facts can support: each returns a question, or null if the
// one it picked won't work (it tries again with another)
export function engineMakers(facts, templates) {
  const T = { ...DEFAULT_TEMPLATES, ...(templates || {}) };
  const of = kind => facts.filter(f => f.kind === kind);
  const defs = of('def'), whens = of('when'), nums = of('num');
  const makers = [];
  // "answer is the a side" or "answer is the b side" of a two-part fact
  const pair = (group, list, slot, prompt, answer, ok) => {
    if (new Set(list.map(f => squash(answer(f)))).size < 4) return;
    makers.push(() => {
      const f = pick(list);
      if (ok && !ok(f)) return null;
      const wrong = wrongOnes(list.map(answer), answer(f));
      return wrong && asked('e:' + group + ':' + squash(f.a + f.b).slice(0, 40), fill(pick(T[group]), slot, prompt(f)), answer(f), wrong);
    });
  };
  // the description mustn't give the term away
  pair('def_term', defs, 'detail', f => f.b, f => f.a, f => !squash(f.b).includes(squash(f.a)));
  // long definitions make long answers, which don't fit a phone mid-game
  pair('def_detail', defs.filter(f => f.b.length <= 60), 'term', f => f.a, f => f.b);
  pair('when', whens, 'event', f => f.a, f => f.b);
  pair('num', nums, 'what', f => f.a, f => f.b);

  const groups = new Map();
  for (const f of of('list')) {
    const k = squash(f.a);
    if (!groups.has(k)) groups.set(k, { name: f.a, members: [] });
    groups.get(k).members.push(f.b);
  }
  const all = [...groups.values()];
  const outside = g => all.filter(o => o !== g).flatMap(o => o.members)
    .filter(m => !g.members.some(x => squash(x) === squash(m)));
  if (all.some(g => outside(g).length >= 3)) {
    makers.push(() => {
      const g = pick(all), right = pick(g.members);
      const wrong = wrongOnes(outside(g), right);
      return wrong && asked('e:list_in:' + squash(g.name + right).slice(0, 40), fill(pick(T.list_in), 'group', g.name), right, wrong);
    });
  }
  if (all.some(g => g.members.length >= 3 && outside(g).length >= 1)) {
    makers.push(() => {
      const g = pick(all), out = outside(g);
      if (g.members.length < 3 || !out.length) return null;
      const odd = pick(out);
      const wrong = wrongOnes(g.members, odd);
      return wrong && asked('e:list_out:' + squash(g.name + odd).slice(0, 40), fill(pick(T.list_out), 'group', g.name), odd, wrong);
    });
  }
  return makers;
}

// set = { name, questions: [{ id, text, choices, answer, why, diff }], facts, templates }
export function setSource(set) {
  const core = set.questions.map(q => ({ ...q, id: 'q:' + q.id, dbId: q.id }));
  const makers = engineMakers(set.facts || [], set.templates);
  let deck = [];
  const fromEngine = () => {
    for (let tries = 0; tries < 8; tries++) {
      const q = pick(makers)();
      if (q) return q;
    }
    return null;
  };
  return {
    name: set.name,
    draw() {
      if (makers.length && (!core.length || Math.random() < ENGINE_SHARE)) {
        const q = fromEngine();
        if (q) return q;
      }
      if (!core.length) return mathsQuestion();
      if (!deck.length) deck = shuffle(core.slice());
      return deck.pop();
    },
  };
}

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

  // what's changed since the last call, for core questions from a study set:
  // [{ dbId, shown, right }]. The room writes these back to the database
  take() {
    const out = [];
    for (const [id, s] of Object.entries(this.stats)) {
      if (!id.startsWith('q:') || (!s.shown && !s.right)) continue;
      out.push({ dbId: id.slice(2), shown: s.shown, right: s.right });
      s.shown = 0; s.right = 0;
    }
    return out;
  }
}
