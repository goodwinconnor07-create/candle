/*
 * The long-lived side of the app, kept in D1: devices (anonymous players),
 * study sets, their source text and generated questions. Live matches don't
 * touch this file; the room only reads questions from it (stage 5).
 */

import { squash } from './generate.js';

const enc = new TextEncoder();

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// a new anonymous player. The secret is returned once and never stored.
// high enough for a classroom sharing one school network
export const MAX_DEVICES_PER_IP_DAY = 30;

// ip is only used to stop one network minting endless devices; it's stored
// hashed. Returns null when that network has made too many today.
export async function createDevice(db, ip) {
  const ipHash = ip ? await sha256('ip:' + ip) : null;
  const now = Date.now();
  if (ipHash) {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM devices WHERE ip_hash = ? AND created_at >= ?')
      .bind(ipHash, now - 86400000).first();
    if (r && r.n >= MAX_DEVICES_PER_IP_DAY) return null;
  }
  const id = randomHex(5);
  const secret = randomHex(24);
  await db.prepare('INSERT INTO devices (id, secret_hash, created_at, last_seen, ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256(secret), now, now, ipHash).run();
  return { id, secret };
}

// who's calling: reads `Authorization: Bearer <secret>`, or null
export async function deviceFrom(db, request) {
  const m = /^Bearer ([0-9a-f]{48})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const row = await db.prepare(
    `SELECT d.id, a.home_device AS home FROM devices d LEFT JOIN accounts a ON a.id = d.account WHERE d.secret_hash = ?`
  ).bind(await sha256(m[1])).first();
  if (!row) return null;
  await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  // a signed-in browser acts as its account's home device, so every browser
  // on the account sees the same sets
  return row.home || row.id;
}

// the browser itself, ignoring any account (for signing in and out)
export async function rawDeviceFrom(db, request) {
  const m = /^Bearer ([0-9a-f]{48})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  return db.prepare(
    `SELECT d.id, a.id AS account, a.email FROM devices d LEFT JOIN accounts a ON a.id = d.account WHERE d.secret_hash = ?`
  ).bind(await sha256(m[1])).first();
}

export async function listSets(db, deviceId) {
  const { results } = await db.prepare(
    `SELECT s.id, s.name, s.updated_at AS updatedAt, s.status, s.gen_note AS note,
            s.copied AS copy,
            (SELECT code FROM share_codes c WHERE c.set_id = s.id AND c.active = 1 LIMIT 1) AS shareCode,
            (SELECT COUNT(*) FROM questions q WHERE q.set_id = s.id AND q.active = 1) AS questions,
            (SELECT COALESCE(SUM(LENGTH(c.body)), 0) FROM source_chunks c WHERE c.set_id = s.id) AS chars
       FROM study_sets s WHERE s.owner = ? ORDER BY s.updated_at DESC`
  ).bind(deviceId).all();
  return results;
}

// ---- study sets ----
export const MAX_SETS = 20;           // per device, for now
export const MAX_TEXT = 200000;       // characters of source per upload
export const MAX_NAME = 60;
const CHUNK = 3000;                   // about this many characters per source chunk

function newId() { return randomHex(8); }

// cut source text into chunks of about CHUNK characters, at paragraph breaks
// where it can and at spaces where a single paragraph is too long
export function chunkText(text) {
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (let para of text.split(/\n+/)) {
    para = para.trim();
    if (!para) continue;
    while (para.length > CHUNK * 1.3) {
      let cut = para.lastIndexOf(' ', CHUNK);
      if (cut < CHUNK / 2) cut = CHUNK;
      if (cur) flush();
      chunks.push(para.slice(0, cut).trim());
      para = para.slice(cut).trim();
    }
    if (cur && cur.length + para.length + 1 > CHUNK) flush();
    cur += (cur ? '\n' : '') + para;
  }
  flush();
  return chunks;
}

export async function countSets(db, deviceId) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM study_sets WHERE owner = ?').bind(deviceId).first();
  return r ? r.n : 0;
}

// a new set from pasted or extracted text. This is the first generation
// event for the set (batch 1); adding more later gets the next batch number.
export async function createSet(db, deviceId, name, text) {
  const id = newId();
  const now = Date.now();
  const chunks = chunkText(text);
  const stmts = [db.prepare('INSERT INTO study_sets (id, owner, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, deviceId, name, now, now)];
  chunks.forEach((body, i) => stmts.push(
    db.prepare('INSERT INTO source_chunks (id, set_id, seq, batch, body, created_at) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(newId(), id, i, body, now)));
  await db.batch(stmts);
  return { id, name, chunks: chunks.length };
}

export async function deleteSet(db, deviceId, setId) {
  const own = await db.prepare('SELECT id FROM study_sets WHERE id = ? AND owner = ?').bind(setId, deviceId).first();
  if (!own) return false;
  // copies made from it keep working; they just stop pointing back at it
  await db.batch([
    db.prepare('UPDATE study_sets SET inherited_from = NULL WHERE inherited_from = ?').bind(setId),
    db.prepare('UPDATE share_codes SET active = 0 WHERE set_id = ?').bind(setId),
    db.prepare('DELETE FROM study_sets WHERE id = ? AND owner = ?').bind(setId, deviceId),
  ]);
  return true;
}

// ---- making questions: reading a set, the spending caps, saving results ----

export async function getSet(db, deviceId, setId) {
  return db.prepare('SELECT id, name, status, gen_started AS genStarted FROM study_sets WHERE id = ? AND owner = ?')
    .bind(setId, deviceId).first();
}

export async function getChunks(db, setId) {
  const { results } = await db.prepare('SELECT id, body FROM source_chunks WHERE set_id = ? ORDER BY seq').bind(setId).all();
  return results;
}

const DAY = 86400000;
export const STALE_RUN_MS = 10 * 60 * 1000;   // a run still going after this is treated as dead

// what's been spent (or is set aside for runs still going) since midnight UTC
export async function spentToday(db, now) {
  const r = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN est_micro ELSE cost_micro END), 0) AS micro
       FROM gen_runs WHERE started >= ?`
  ).bind(now - now % DAY).first();
  return r ? r.micro : 0;
}

export async function runsToday(db, deviceId, now) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM gen_runs WHERE device = ? AND started >= ?')
    .bind(deviceId, now - now % DAY).first();
  return r ? r.n : 0;
}

// takes the set for a run: only one run at a time, and only for a set that
// hasn't got questions yet. A run that's been going too long is written off
// (at its estimate, since we can't know) so the set can be tried again.
export async function startRun(db, deviceId, setId, estMicro, now, accountId) {
  await db.prepare(`UPDATE gen_runs SET status = 'failed', finished = ?, cost_micro = est_micro
                     WHERE set_id = ? AND status = 'running' AND started < ?`).bind(now, setId, now - STALE_RUN_MS).run();
  const claim = await db.prepare(
    `UPDATE study_sets SET status = 'generating', gen_started = ?, gen_note = NULL, updated_at = ?
      WHERE id = ? AND owner = ? AND (status IN ('new', 'failed') OR (status = 'generating' AND gen_started < ?))`
  ).bind(now, now, setId, deviceId, now - STALE_RUN_MS).run();
  if (!claim.meta.changes) return null;
  const runId = newId();
  await db.prepare('INSERT INTO gen_runs (id, set_id, device, started, status, est_micro, account) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(runId, setId, deviceId, now, 'running', estMicro, accountId || null).run();
  return runId;
}

async function batched(db, stmts) {
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

// writes a finished run: the questions, the facts and the template wording,
// then marks the set ready. Questions replace any earlier ones from batch 1.
export async function saveRun(db, setId, runId, out, chunks, costMicroTotal) {
  const now = Date.now();
  const norm = c => c.norm || (c.norm = squash(c.body));
  const stmts = [
    db.prepare('DELETE FROM questions WHERE set_id = ? AND batch = 1').bind(setId),
    db.prepare('DELETE FROM facts WHERE set_id = ? AND batch = 1').bind(setId),
  ];
  for (const q of out.questions) {
    const quote = squash(q.quote);
    const home = chunks.find(c => norm(c).includes(quote));
    stmts.push(db.prepare(
      `INSERT INTO questions (id, set_id, chunk_id, text, choices, answer, why, diff, batch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(newId(), setId, home ? home.id : null, q.text, JSON.stringify(q.choices), q.answer, q.why, q.diff, now));
  }
  for (const f of out.facts) {
    stmts.push(db.prepare('INSERT INTO facts (id, set_id, kind, a, b, batch, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .bind(newId(), setId, f.kind, f.a, f.b, now));
  }
  await batched(db, stmts);
  await db.batch([
    db.prepare(`UPDATE study_sets SET status = 'ready', gen_note = NULL, subject = ?, templates = ?, updated_at = ? WHERE id = ?`)
      .bind(out.subject, JSON.stringify(out.templates), now, setId),
    db.prepare(`UPDATE gen_runs SET status = 'done', finished = ?, cost_micro = ?, detail = ? WHERE id = ?`)
      .bind(now, costMicroTotal, JSON.stringify({ calls: out.calls.map(c => ({ kind: c.kind, model: c.model, usage: c.usage, cost: c.cost })), dropped: out.dropped, failed: out.failed }), runId),
  ]);
}

export async function failRun(db, setId, runId, note, costMicroTotal, detail) {
  const now = Date.now();
  await db.batch([
    db.prepare(`UPDATE study_sets SET status = 'failed', gen_note = ?, updated_at = ? WHERE id = ?`).bind(note, now, setId),
    db.prepare(`UPDATE gen_runs SET status = 'failed', finished = ?, cost_micro = ?, detail = ? WHERE id = ?`)
      .bind(now, costMicroTotal, detail ? JSON.stringify(detail) : null, runId),
    // the credit comes back, never past the free allowance
    db.prepare(`UPDATE accounts SET credits = MIN(?, credits + 1) WHERE id = (SELECT account FROM gen_runs WHERE id = ?)`).bind(FREE_CREDITS, runId),
  ]);
}

// ---- study sets in a match ----

// the device a raw secret belongs to (the guest sends theirs over the socket)
export async function deviceBySecret(db, secret) {
  if (!/^[0-9a-f]{48}$/.test(String(secret || ''))) return null;
  const row = await db.prepare(
    `SELECT d.id, a.home_device AS home FROM devices d LEFT JOIN accounts a ON a.id = d.account WHERE d.secret_hash = ?`
  ).bind(await sha256(secret)).first();
  return row ? row.home || row.id : null;
}

// a set this device may play with: its own, and only once it has questions
export async function playableSet(db, deviceId, setId) {
  if (!deviceId || !/^[0-9a-f]{16}$/.test(String(setId || ''))) return null;
  return db.prepare(`SELECT id, name FROM study_sets WHERE id = ? AND owner = ? AND status = 'ready'`).bind(setId, deviceId).first();
}

// everything the room needs to ask questions from a set
export async function loadSetForGame(db, setId) {
  const set = await db.prepare('SELECT id, name, templates FROM study_sets WHERE id = ?').bind(setId).first();
  if (!set) return null;
  const [qs, fs] = await db.batch([
    db.prepare('SELECT id, text, choices, answer, why, diff FROM questions WHERE set_id = ? AND active = 1').bind(setId),
    db.prepare('SELECT kind, a, b FROM facts WHERE set_id = ?').bind(setId),
  ]);
  let templates = null;
  try { templates = JSON.parse(set.templates || 'null'); } catch (e) {}
  return {
    name: set.name,
    templates,
    facts: fs.results,
    questions: qs.results.map(q => ({ id: q.id, text: q.text, choices: JSON.parse(q.choices), answer: q.answer, why: q.why, diff: q.diff })),
  };
}

// how often each core question was shown and answered right, for picking
// and difficulty later
export async function recordAnswers(db, rows) {
  if (!rows.length) return;
  await batched(db, rows.map(r => db.prepare('UPDATE questions SET shown = shown + ?, right = right + ? WHERE id = ?').bind(r.shown, r.right, r.dbId)));
}

// ---- share codes ----

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L
export const LOOKUPS_PER_HOUR = 30;

export function cleanCode(c) {
  const v = String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return v.length === 6 && [...v].every(ch => CODE_CHARS.includes(ch)) ? v : null;
}

// the set's code, made the first time it's shared. only the owner's own
// sets can be shared, not copies (no re-sharing for now)
export async function shareSet(db, deviceId, setId) {
  const set = await db.prepare(`SELECT id FROM study_sets WHERE id = ? AND owner = ? AND status = 'ready' AND copied = 0`)
    .bind(setId, deviceId).first();
  if (!set) return null;
  const had = await db.prepare('SELECT code FROM share_codes WHERE set_id = ? AND active = 1').bind(setId).first();
  if (had) return had.code;
  for (let i = 0; i < 6; i++) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const code = [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    const r = await db.prepare('INSERT OR IGNORE INTO share_codes (code, set_id, owner, created_at) VALUES (?, ?, ?, ?)')
      .bind(code, setId, deviceId, Date.now()).run();
    if (r.meta.changes) return code;
  }
  return null;
}

export async function unshareSet(db, deviceId, setId) {
  await db.prepare('UPDATE share_codes SET active = 0 WHERE set_id = ? AND owner = ?').bind(setId, deviceId).run();
}

// counts this lookup; false once the device has tried too many this hour
export async function lookupAllowed(db, deviceId) {
  const now = Date.now();
  const r = await db.prepare('SELECT COUNT(*) AS n FROM share_lookups WHERE device = ? AND at >= ?').bind(deviceId, now - 3600000).first();
  if (r && r.n >= LOOKUPS_PER_HOUR) return false;
  await db.prepare('INSERT INTO share_lookups (device, at) VALUES (?, ?)').bind(deviceId, now).run();
  return true;
}

export async function codeInfo(db, code) {
  return db.prepare(
    `SELECT s.id, s.name, s.owner,
            (SELECT COUNT(*) FROM questions q WHERE q.set_id = s.id AND q.active = 1) AS questions
       FROM share_codes c JOIN study_sets s ON s.id = c.set_id
      WHERE c.code = ? AND c.active = 1 AND s.status = 'ready'`
  ).bind(code).first();
}

// the person's own copy: questions, facts and wording as they are now. the
// notes stay with the owner. a copy is ready at once and costs nothing
export async function copySet(db, deviceId, src) {
  const id = newId(), now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO study_sets (id, owner, name, inherited_from, copied, status, subject, templates, created_at, updated_at)
                SELECT ?, ?, name, id, 1, 'ready', subject, templates, ?, ? FROM study_sets WHERE id = ?`).bind(id, deviceId, now, now, src.id),
    db.prepare(`INSERT INTO questions (id, set_id, chunk_id, text, choices, answer, why, diff, batch, created_at)
                SELECT lower(hex(randomblob(8))), ?, NULL, text, choices, answer, why, diff, batch, ? FROM questions WHERE set_id = ? AND active = 1`).bind(id, now, src.id),
    db.prepare(`INSERT INTO facts (id, set_id, kind, a, b, batch, created_at)
                SELECT lower(hex(randomblob(8))), ?, kind, a, b, batch, ? FROM facts WHERE set_id = ?`).bind(id, now, src.id),
  ]);
  return { id, name: src.name };
}

// ---- accounts: email sign-in codes ----

export const CODE_TTL_MS = 10 * 60 * 1000;
export function cleanEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  return v.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

// a new 6-digit code for this email, or null when too many were asked for.
// purpose is 'signup' (carrying the chosen password's hash) or 'reset'
export async function newLoginCode(db, email, deviceId, purpose, pendingHash) {
  const now = Date.now(), hour = now - 3600000;
  const [byEmail, byDevice] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at >= ?').bind(email, hour),
    db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE device = ? AND created_at >= ?').bind(deviceId, hour),
  ]);
  if (byEmail.results[0].n >= 5 || byDevice.results[0].n >= 10) return null;
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  const code = String(n[0] % 1000000).padStart(6, '0');
  await db.prepare('INSERT INTO login_codes (email, code_hash, device, expires, created_at, purpose, pending_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(email, await sha256('login:' + email + ':' + code), deviceId, now + CODE_TTL_MS, now, purpose, pendingHash || null).run();
  return code;
}

// checks the newest live code of this purpose for this email. Five wrong
// tries and it's spent. Returns the code's row (with any pending password)
export async function checkLoginCode(db, email, code, purpose) {
  const now = Date.now();
  const row = await db.prepare('SELECT rowid, code_hash, tries, pending_hash AS pending FROM login_codes WHERE email = ? AND purpose = ? AND expires > ? ORDER BY created_at DESC LIMIT 1')
    .bind(email, purpose, now).first();
  if (!row || row.tries >= 5) return null;
  if (row.code_hash !== await sha256('login:' + email + ':' + String(code || '').replace(/\D/g, ''))) {
    await db.prepare('UPDATE login_codes SET tries = tries + 1 WHERE rowid = ?').bind(row.rowid).run();
    return null;
  }
  await db.prepare('UPDATE login_codes SET expires = 0 WHERE email = ? AND purpose = ?').bind(email, purpose).run();
  return row;
}

export async function accountByEmail(db, email) {
  return db.prepare('SELECT id, home_device AS home, pass_hash AS pass, credits FROM accounts WHERE email = ?').bind(email).first();
}

export async function setPassword(db, email, hash) {
  await db.prepare('UPDATE accounts SET pass_hash = ? WHERE email = ?').bind(hash, email).run();
}

// wrong passwords for this email in the last hour (and note one more)
export async function recentFails(db, email) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM login_fails WHERE email = ? AND at >= ?').bind(email, Date.now() - 3600000).first();
  return r ? r.n : 0;
}
export async function noteFail(db, email) {
  await db.prepare('INSERT INTO login_fails (email, at) VALUES (?, ?)').bind(email, Date.now()).run();
}

// ---- credits: 3 per account, one per set made, given back if the run fails ----
export const FREE_CREDITS = 3;
export async function creditsLeft(db, accountId) {
  const r = accountId && await db.prepare('SELECT credits FROM accounts WHERE id = ?').bind(accountId).first();
  return r ? r.credits : 0;
}
export async function takeCredit(db, accountId) {
  const r = await db.prepare('UPDATE accounts SET credits = credits - 1 WHERE id = ? AND credits > 0').bind(accountId).run();
  return r.meta.changes > 0;
}

// links this browser to the email's account, making the account if it's new.
// A browser joining an existing account brings its sets with it
export async function signIn(db, deviceId, email, passHash) {
  let acc = await db.prepare('SELECT id, home_device AS home FROM accounts WHERE email = ?').bind(email).first();
  if (!acc) {
    acc = { id: newId(), home: deviceId };
    await db.prepare('INSERT INTO accounts (id, email, home_device, created_at, pass_hash) VALUES (?, ?, ?, ?, ?)').bind(acc.id, email, deviceId, Date.now(), passHash || null).run();
  } else if (passHash) {
    await setPassword(db, email, passHash);
  }
  const stmts = [db.prepare('UPDATE devices SET account = ? WHERE id = ?').bind(acc.id, deviceId)];
  if (acc.home !== deviceId) {
    stmts.push(
      db.prepare('UPDATE study_sets SET owner = ? WHERE owner = ?').bind(acc.home, deviceId),
      db.prepare('UPDATE share_codes SET owner = ? WHERE owner = ?').bind(acc.home, deviceId),
    );
  }
  await db.batch(stmts);
  return acc.home;
}

export async function signOut(db, deviceId) {
  await db.prepare('UPDATE devices SET account = NULL WHERE id = ?').bind(deviceId).run();
}

// ---- keeping a friend's set after a match ----

export async function makeKeepToken(db, setId) {
  const token = randomHex(16);
  await db.prepare('INSERT INTO keep_tokens (token, set_id, expires) VALUES (?, ?, ?)').bind(token, setId, Date.now() + 2 * 86400000).run();
  return token;
}

// copies the set behind a keep token, unless it's gone, already theirs, or
// already copied by them
export async function keepSet(db, deviceId, token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const t = await db.prepare('SELECT set_id FROM keep_tokens WHERE token = ? AND expires > ?').bind(token, Date.now()).first();
  if (!t) return null;
  const src = await db.prepare(`SELECT id, name, owner FROM study_sets WHERE id = ? AND status = 'ready'`).bind(t.set_id).first();
  if (!src || src.owner === deviceId) return null;
  const had = await db.prepare('SELECT id, name FROM study_sets WHERE owner = ? AND inherited_from = ?').bind(deviceId, src.id).first();
  if (had) return had;
  if (await countSets(db, deviceId) >= MAX_SETS) return null;
  return copySet(db, deviceId, src);
}
