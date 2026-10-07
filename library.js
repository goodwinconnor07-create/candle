/*
 * The long-lived side of the app, kept in D1: devices (anonymous players),
 * study sets, their source text and generated questions. Live matches don't
 * touch this file; the room only reads questions from it (stage 5).
 */

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
export async function createDevice(db) {
  const id = randomHex(5);
  const secret = randomHex(24);
  const now = Date.now();
  await db.prepare('INSERT INTO devices (id, secret_hash, created_at, last_seen) VALUES (?, ?, ?, ?)')
    .bind(id, await sha256(secret), now, now).run();
  return { id, secret };
}

// who's calling: reads `Authorization: Bearer <secret>`, or null
export async function deviceFrom(db, request) {
  const m = /^Bearer ([0-9a-f]{48})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const row = await db.prepare('SELECT id FROM devices WHERE secret_hash = ?').bind(await sha256(m[1])).first();
  if (!row) return null;
  await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return row.id;
}

export async function listSets(db, deviceId) {
  const { results } = await db.prepare(
    `SELECT s.id, s.name, s.updated_at AS updatedAt,
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
  const r = await db.prepare('DELETE FROM study_sets WHERE id = ? AND owner = ?').bind(setId, deviceId).run();
  return r.meta.changes > 0;
}
