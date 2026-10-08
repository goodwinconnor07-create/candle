/*
 * Where every question in a match comes from.
 *
 * A game never builds a question itself. It asks its player's feed for the
 * next one (`Feed.next()`), and the feed asks a source: the maths placeholder,
 * or a study set (`setSource()`).
 *
 * A study set has two supplies:
 *  - core questions, written by Claude when the set was made (or topped up);
 *  - the local engine (`engineMakers()`), which builds questions for free
 *    from the set's master sheet: concepts and their definitions and
 *    properties, links between concepts, ordered steps, numbers and common
 *    mix-ups. It can make hundreds of different questions from one sheet.
 *
 * Each player's feed remembers what they've seen before (across matches,
 * when they're signed in or have a device), prefers what they haven't, and
 * picks questions near their level using a simple rating (like chess
 * ratings). Wrong answers players actually fall for are fed back so the
 * engine uses them as distractors more often.
 *
 * A question is { id, text, choices, answer, diff, rating, why? }. Only text
 * and choices (and answer once resolved) ever reach a browser; ratings and
 * difficulty are never shown to players.
 */

import { DEFAULT_TEMPLATES, squash } from './generate.js';

const RECENT = 8;                 // a question doesn't come back until this many others have
export const RATING0 = 1500;      // where every player starts
const K_PLAYER = 32, K_QUESTION = 12;
// a question this many points easier than the player is answered right about
// 70% of the time, which keeps a match moving without being trivial
const TARGET_GAP = 147;
const ENGINE_SHARE = 1 / 3;       // engine questions while the player still has unseen core ones
const ENGINE_SHARE_LATE = 0.6;    // once they've seen every core question

function rnd(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const pick = arr => arr[rnd(arr.length)];
const tidyVal = v => String(v).trim().replace(/[\s.;:,]+$/, '');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
export const expected = (player, question) => 1 / (1 + Math.pow(10, (question - player) / 400));

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
  diff = Math.max(0, Math.min(1, diff));
  return { id: 'm:' + text, text, choices, answer: choices.indexOf(value), diff, rating: 1300 + diff * 400 };
}

export const mathsSource = { name: 'Quick maths', draw: mathsQuestion };

// ---- the master sheet ----
// { concepts: [{ name, category, definition, alt: [], props: [{ key, value }] }],
//   links: [{ a, rel, b }], steps: [{ process, items: [] }],
//   numbers: [{ what, value, unit }], mixups: [{ wrong, right }] }

export function emptySheet() {
  return { concepts: [], links: [], steps: [], numbers: [], mixups: [] };
}

// sets made before the master sheet only have the old facts table
export function sheetFromFacts(facts) {
  const sh = emptySheet();
  for (const f of facts || []) {
    if (f.kind === 'def') sh.concepts.push({ name: f.a, category: '', definition: f.b, alt: [], props: [] });
    else if (f.kind === 'list') sh.concepts.push({ name: f.b, category: f.a, definition: '', alt: [], props: [] });
    else if (f.kind === 'num' || f.kind === 'when') sh.numbers.push({ what: f.a, value: f.b, unit: '' });
  }
  return mergeSheets([sh]);
}

// joins the sheets from each slice of the notes, merging repeats
export function mergeSheets(list) {
  const out = emptySheet();
  const byName = new Map(), seen = new Set();
  const once = key => (seen.has(key) ? false : (seen.add(key), true));
  for (const sh of list) {
    if (!sh) continue;
    for (const c of sh.concepts || []) {
      const k = squash(c.name);
      if (!k) continue;
      const had = byName.get(k);
      if (!had) {
        const n = { name: c.name, category: c.category || '', definition: c.definition || '', alt: [...(c.alt || [])], props: [...(c.props || [])] };
        byName.set(k, n); out.concepts.push(n);
      } else {
        had.category = had.category || c.category || '';
        if (!had.definition) had.definition = c.definition || '';
        else if (c.definition && squash(c.definition) !== squash(had.definition)) had.alt.push(c.definition);
        had.alt.push(...(c.alt || []));
        for (const p of c.props || []) if (!had.props.some(x => squash(x.key) === squash(p.key))) had.props.push(p);
      }
    }
    for (const l of sh.links || []) if (once('l|' + squash(l.a) + '|' + squash(l.rel) + '|' + squash(l.b))) out.links.push(l);
    for (const s of sh.steps || []) if (once('s|' + squash(s.process))) out.steps.push(s);
    for (const n of sh.numbers || []) if (once('n|' + squash(n.what))) out.numbers.push(n);
    for (const m of sh.mixups || []) if (once('m|' + squash(m.wrong))) out.mixups.push(m);
  }
  return out;
}

// ---- the engine ----

// three different wrong answers from `pool`, none equal to `right`. The ones
// players have actually fallen for (picks) come up more often
function wrongOnes(pool, right, picks, n = 3) {
  const seen = new Set([squash(right)]);
  const cands = [];
  for (const v of pool) {
    const k = squash(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cands.push({ v: tidyVal(v), w: (1 + 2 * ((picks && picks.get(k)) || 0)) * Math.random() });
  }
  if (cands.length < n) return null;
  return cands.sort((a, b) => b.w - a.w).slice(0, n).map(c => c.v);
}

function fill(template, slot, value) {
  return template.split('{' + slot + '}').join(tidyVal(value));
}

// a finished engine question. `slot` is the key term rewording must keep
function asked(kind, key, text, right, wrong, rating, slot) {
  const choices = shuffle([tidyVal(right), ...wrong]);
  return {
    id: 'e:' + kind + ':' + squash(key).slice(0, 48), kind, text, stem: text, slot: slot || '',
    choices, answer: choices.indexOf(tidyVal(right)), diff: (rating - 1300) / 400, rating, why: null,
  };
}

// nearby believable numbers in the same form ("15%" → "30%", "7.5%", "19%")
export function nearbyNumbers(value) {
  const m = /^(\D*?)(\d[\d,]*\.?\d*)(.*)$/.exec(String(value).trim());
  if (!m) return [];
  const n = Number(m[2].replace(/,/g, ''));
  if (!isFinite(n) || n === 0) return [];
  const dp = (m[2].split('.')[1] || '').length;
  const fmt = x => {
    let s = dp ? x.toFixed(dp) : String(Math.round(x));
    if (m[2].includes(',')) s = Number(s).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return m[1] + s + m[3];
  };
  const step = Math.max(1, Math.round(n * 0.25));
  // small whole numbers can be one out; bigger ones never off by a single unit
  const near = n < 20 && !dp ? [n + 1, n - 1] : [n * 1.1, n * 0.9].map(x => (dp ? x : Math.round(x)));
  const vals = dp ? [n * 2, n / 2, n * 1.25, n * 0.75, ...near] : [n * 2, Math.round(n / 2), n + step, n - step, ...near];
  return [...new Set(vals.filter(x => x > 0 && x !== n).map(fmt))].filter(v => v !== String(value).trim());
}

const BASE = {
  term: 1450, define: 1500, prop: 1550, member: 1400, odd: 1500, link: 1550, first: 1450,
  next: 1600, order: 1700, number: 1600, truth: 1550, untruth: 1650, mixup: 1650,
};

// every kind of question the sheet can support. Each maker returns a
// question, or null if the one it picked won't work (the caller tries again)
export function engineMakers(sheet, templates, picks) {
  const T = { ...DEFAULT_TEMPLATES, ...(templates || {}) };
  const sh = sheet || emptySheet();
  const concepts = sh.concepts || [];
  const names = concepts.map(c => c.name);
  const makers = [];
  const add = (kind, fn) => makers.push({ kind, make: fn });

  // term from its definition, worded a different way each time when the
  // sheet has rewordings; wrong answers from the same category first
  const defined = concepts.filter(c => c.definition);
  const sameCat = c => concepts.filter(x => x !== c && x.category && squash(x.category) === squash(c.category)).map(x => x.name);
  if (defined.length >= 4) {
    add('term', () => {
      const c = pick(defined);
      const words = [c.definition, ...(c.alt || [])].filter(d => d && !squash(d).includes(squash(c.name)));
      if (!words.length) return null;
      const peers = sameCat(c);
      const wrong = wrongOnes(peers.length >= 3 ? peers : names, c.name, picks);
      return wrong && asked('term', c.name, fill(pick(T.def_term), 'detail', pick(words)), c.name, wrong, BASE.term);
    });
    const short = defined.map(c => ({ c, d: [c.definition, ...(c.alt || [])].filter(Boolean).sort((a, b) => a.length - b.length)[0] }))
      .filter(x => x.d && x.d.length <= 70);
    if (short.length >= 4) {
      add('define', () => {
        const { c, d } = pick(short);
        const wrong = wrongOnes(short.filter(x => x.c !== c).map(x => x.d), d, picks);
        return wrong && asked('define', c.name, fill(pick(T.def_detail), 'term', c.name), d, wrong, BASE.define, c.name);
      });
    }
  }

  // a property: "what is the tax rate of concessional contributions?"
  const props = [];
  for (const c of concepts) for (const p of c.props || []) if (p.key && p.value) props.push({ c, key: p.key, value: p.value });
  if (props.length) {
    add('prop', () => {
      const p = pick(props);
      const same = props.filter(x => x !== p && squash(x.key) === squash(p.key)).map(x => x.value);
      const wrong = wrongOnes(same.length >= 3 ? same : [...same, ...nearbyNumbers(p.value)], p.value, picks);
      return wrong && asked('prop', p.c.name + p.key, `What is the ${tidyVal(p.key)} of ${tidyVal(p.c.name)}?`, p.value, wrong, BASE.prop, p.c.name);
    });
  }

  // categories: which belongs, and which is the odd one out
  const groups = new Map();
  for (const c of concepts) {
    if (!c.category) continue;
    const k = squash(c.category);
    if (!groups.has(k)) groups.set(k, { name: c.category, members: [] });
    groups.get(k).members.push(c.name);
  }
  const all = [...groups.values()];
  const outside = g => names.filter(n => !g.members.some(m => squash(m) === squash(n)));
  const memberGroups = all.filter(g => g.members.length >= 1 && outside(g).length >= 3);
  if (memberGroups.length) {
    add('member', () => {
      const g = pick(memberGroups), right = pick(g.members);
      const wrong = wrongOnes(outside(g), right, picks);
      return wrong && asked('member', g.name + right, fill(pick(T.list_in), 'group', g.name), right, wrong, BASE.member, g.name);
    });
  }
  const oddGroups = all.filter(g => g.members.length >= 3 && outside(g).length >= 1);
  if (oddGroups.length) {
    add('odd', () => {
      const g = pick(oddGroups), odd = pick(outside(g));
      const wrong = wrongOnes(g.members, odd, null);
      return wrong && asked('odd', g.name + odd, fill(pick(T.list_out), 'group', g.name), odd, wrong, BASE.odd, g.name);
    });
  }

  // links between concepts
  const links = (sh.links || []).filter(l => l.a && l.rel && l.b);
  const linked = new Set(links.map(l => squash(l.a) + '|' + squash(l.rel) + '|' + squash(l.b)));
  const isLink = (a, rel, b) => linked.has(squash(a) + '|' + squash(rel) + '|' + squash(b));
  const sentence = (a, rel, b) => cap(`${tidyVal(a)} ${tidyVal(rel)} ${tidyVal(b)}`);
  const thingsA = [...new Set([...names, ...links.map(l => l.a)])];
  const thingsB = [...new Set([...names, ...links.map(l => l.b)])];
  if (links.length) {
    add('link', () => {
      const l = pick(links);
      const wrong = wrongOnes(thingsA.filter(x => !isLink(x, l.rel, l.b)), l.a, picks);
      return wrong && asked('link', l.a + l.rel + l.b, `Which of these ${tidyVal(l.rel)} ${tidyVal(l.b)}?`, l.a, wrong, BASE.link, l.b);
    });
    // a false statement: the same link with the far end swapped for something
    // the sheet doesn't say, so none of the "false" ones is secretly true
    // the swap has to be believable: something of the same category as the
    // real far end, or another far end of the same kind of link
    const catOf = new Map(concepts.map(c => [squash(c.name), squash(c.category || '')]));
    const falseOf = l => {
      const cat = catOf.get(squash(l.b));
      const likeB = [
        ...(cat ? concepts.filter(c => squash(c.category || '') === cat).map(c => c.name) : []),
        ...links.filter(x => squash(x.rel) === squash(l.rel)).map(x => x.b),
      ];
      const swaps = likeB.filter(b => squash(b) !== squash(l.b) && squash(b) !== squash(l.a) && !isLink(l.a, l.rel, b));
      return swaps.length ? sentence(l.a, l.rel, pick(swaps)) : null;
    };
    if (links.length >= 1 && thingsB.length >= 4) {
      add('truth', () => {
        const l = pick(links);
        const fakes = [];
        for (let i = 0; i < 8 && fakes.length < 3; i++) {
          const f = falseOf(pick(links));
          if (f && !fakes.includes(f) && squash(f) !== squash(sentence(l.a, l.rel, l.b))) fakes.push(f);
        }
        return fakes.length === 3 && asked('truth', l.a + l.rel + l.b, 'Which of these statements is true?', sentence(l.a, l.rel, l.b), fakes, BASE.truth);
      });
    }
    if (links.length >= 3 && thingsB.length >= 4) {
      add('untruth', () => {
        const trio = shuffle(links.slice()).slice(0, 3);
        const fake = falseOf(pick(links));
        if (!fake || trio.some(l => squash(sentence(l.a, l.rel, l.b)) === squash(fake))) return null;
        return asked('untruth', fake, 'Which of these statements is NOT true?', fake, trio.map(l => sentence(l.a, l.rel, l.b)), BASE.untruth);
      });
    }
  }

  // ordered steps
  const procs = (sh.steps || []).filter(s => s.process && (s.items || []).length >= 4);
  if (procs.length) {
    add('first', () => {
      const s = pick(procs);
      const wrong = wrongOnes(s.items.slice(1), s.items[0], null);
      return wrong && asked('first', s.process + 'first', `What is the first step in ${tidyVal(s.process)}?`, s.items[0], wrong, BASE.first, s.process);
    });
    add('next', () => {
      const s = pick(procs), i = rnd(s.items.length - 1);
      const wrong = wrongOnes(s.items.filter((_, j) => j !== i && j !== i + 1), s.items[i + 1], null);
      return wrong && asked('next', s.process + i, `In ${tidyVal(s.process)}, what comes straight after “${tidyVal(s.items[i])}”?`, s.items[i + 1], wrong, BASE.next, s.items[i]);
    });
    const shortProcs = procs.filter(s => s.items.slice(0, 4).every(x => x.length <= 22));
    if (shortProcs.length) {
      add('order', () => {
        const s = pick(shortProcs), items = s.items.slice(0, Math.min(4, s.items.length));
        const right = items.join(' → ');
        const wrongs = new Set();
        for (let i = 0; i < 20 && wrongs.size < 3; i++) {
          const o = shuffle(items.slice()).join(' → ');
          if (o !== right) wrongs.add(o);
        }
        return wrongs.size === 3 && asked('order', s.process + 'order', `Which is the right order for ${tidyVal(s.process)}?`, right, [...wrongs], BASE.order, s.process);
      });
    }
  }

  // numbers, with believable nearby values when the sheet has few to compare
  const nums = (sh.numbers || []).filter(n => n.what && n.value);
  if (nums.length) {
    const full = n => tidyVal(n.unit && !squash(n.value).includes(squash(n.unit)) ? `${n.value} ${n.unit}` : n.value);
    add('number', () => {
      const n = pick(nums), right = full(n);
      const same = nums.filter(x => x !== n && squash(x.unit || '') === squash(n.unit || '')).map(full);
      const wrong = wrongOnes([...nearbyNumbers(right), ...same], right, picks);
      return wrong && asked('number', n.what, fill(pick(T.num), 'what', n.what), right, wrong, BASE.number, n.what);
    });
  }

  // common mix-ups: the wrong belief against true statements
  const mix = (sh.mixups || []).filter(m => m.wrong);
  const truths = [...mix.map(m => m.right).filter(Boolean), ...links.map(l => sentence(l.a, l.rel, l.b))];
  if (mix.length && truths.length >= 3) {
    add('mixup', () => {
      const m = pick(mix);
      const wrong = wrongOnes(truths, m.wrong, null);
      return wrong && asked('mixup', m.wrong, 'Which of these is a common mix-up, not a fact?', cap(tidyVal(m.wrong)), wrong.map(cap), BASE.mixup);
    });
  }
  return makers;
}

// every distinct engine question the sheet can make, for testing and for
// deciding when a set has been played through (not used in a match)
export function engineCount(makers, tries = 4000) {
  const ids = new Set();
  for (let i = 0; i < tries && makers.length; i++) {
    const q = makers[i % makers.length].make();
    if (q) ids.add(q.id);
  }
  return ids.size;
}

// set = { id, name, questions: [{ id, text, choices, answer, why, diff, rating }],
//   sheet, templates, picks: Map(value → times picked wrongly), reword: Map(stem → text) }
export function setSource(set) {
  const core = (set.questions || []).map(q => ({ ...q, id: 'q:' + q.id, dbId: q.id, rating: q.rating || 1300 + (q.diff || 0.5) * 400 }));
  const picks = set.picks || new Map();
  return {
    name: set.name, setId: set.id, core, picks,
    reword: set.reword || new Map(),
    makers: engineMakers(set.sheet || sheetFromFacts(set.facts), set.templates, picks),
  };
}

// one player's questions for a match. memory = { seen: Map(id → { shown,
// right, last }), rating } from earlier matches, or nothing
export class Feed {
  constructor(source, memory) {
    this.source = source || mathsSource;
    this.recent = [];
    this.stats = {};          // core question id → { shown, right, dRating } this match
    this.seenNow = {};        // any question id → { shown, right }
    this.picks = [];          // wrong answers chosen this match
    this.memory = memory || { seen: new Map(), rating: RATING0 };
    this.rating = this.memory.rating || RATING0;
    this.ratingAtStart = this.rating;
    this.deck = null;
  }

  // the core questions in the order this player should meet them: ones
  // they've never seen, then ones they got wrong, then the rest, oldest first
  buildDeck() {
    const seen = this.memory.seen;
    const fresh = [], missed = [], rest = [];
    for (const q of this.source.core) {
      const s = seen.get(q.id);
      if (!s) fresh.push(q);
      else if (s.right < s.shown) missed.push(q);
      else rest.push(q);
    }
    rest.sort((a, b) => (seen.get(a.id).last || 0) - (seen.get(b.id).last || 0));
    this.deck = [...shuffle(fresh), ...shuffle(missed), ...rest];
  }

  // of a few candidates, the one closest to this player's level
  nearest(cands) {
    const want = this.rating - TARGET_GAP;
    return cands.sort((a, b) => Math.abs(a.rating - want) - Math.abs(b.rating - want))[0];
  }

  fromEngine() {
    const makers = this.source.makers || [];
    const cands = [];
    for (let tries = 0; tries < 16 && cands.length < 4; tries++) {
      const q = pick(makers).make();
      if (q && !this.recent.includes(q.id) && !cands.some(c => c.id === q.id)) cands.push(q);
    }
    if (!cands.length) return null;
    const q = this.nearest(cands);
    const better = this.source.reword && this.source.reword.get(squash(q.stem));
    if (better) q.text = better;
    return q;
  }

  fromCore() {
    if (!this.deck || !this.deck.length) this.buildDeck();
    const cands = this.deck.slice(0, 5).filter(q => !this.recent.includes(q.id));
    const q = cands.length ? this.nearest(cands) : this.deck[0];
    if (!q) return null;
    this.deck.splice(this.deck.indexOf(q), 1);
    return q;
  }

  next() {
    let q;
    const src = this.source;
    if (!src.core) {
      q = src.draw();
      for (let tries = 0; tries < 6 && this.recent.includes(q.id); tries++) q = src.draw();
    } else {
      const unseen = src.core.some(c => !this.memory.seen.has(c.id) && !this.seenNow[c.id]);
      const share = !src.core.length ? 1 : unseen ? ENGINE_SHARE : ENGINE_SHARE_LATE;
      if ((src.makers || []).length && Math.random() < share) q = this.fromEngine();
      if (!q) q = this.fromCore() || this.fromEngine() || mathsQuestion();
    }
    this.recent.push(q.id);
    if (this.recent.length > RECENT) this.recent.shift();
    const s = this.seenNow[q.id] || (this.seenNow[q.id] = { shown: 0, right: 0 });
    s.shown += 1;
    if (q.dbId) (this.stats[q.id] || (this.stats[q.id] = { shown: 0, right: 0, dRating: 0 })).shown += 1;
    return q;
  }

  // pickedText: the answer they chose, when it was wrong
  result(q, right, pickedText) {
    if (!q) return;
    const e = expected(this.rating, q.rating || RATING0);
    const s = right ? 1 : 0;
    this.rating += K_PLAYER * (s - e);
    if (right && this.seenNow[q.id]) this.seenNow[q.id].right += 1;
    if (q.dbId) {
      const st = this.stats[q.id] || (this.stats[q.id] = { shown: 0, right: 0, dRating: 0 });
      if (right) st.right += 1;
      const d = -K_QUESTION * (s - e);   // a question people miss gets harder
      st.dRating += d;
      q.rating += d;
    }
    if (!right && pickedText != null && pickedText !== '') this.picks.push(squash(pickedText));
  }

  // what's changed since the last call, for the database
  take() {
    const questions = [];
    for (const [id, s] of Object.entries(this.stats)) {
      if (!s.shown && !s.right && !s.dRating) continue;
      questions.push({ dbId: id.slice(2), shown: s.shown, right: s.right, dRating: s.dRating });
      s.shown = 0; s.right = 0; s.dRating = 0;
    }
    const seen = [];
    for (const [id, s] of Object.entries(this.seenNow)) {
      if (!s.shown && !s.right) continue;
      if (!id.startsWith('m:')) seen.push({ qkey: id, shown: s.shown, right: s.right });
      const m = this.memory.seen.get(id) || { shown: 0, right: 0, last: 0 };
      m.shown += s.shown; m.right += s.right; m.last = Date.now();
      this.memory.seen.set(id, m);
      s.shown = 0; s.right = 0;
    }
    const picks = this.picks;
    this.picks = [];
    const rating = this.rating !== this.ratingAtStart ? this.rating : null;
    this.ratingAtStart = this.rating;
    return { questions, seen, picks, rating };
  }
}
