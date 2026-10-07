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
            (SELECT COUNT(*) FROM questions q WHERE q.set_id = s.id AND q.active = 1) AS questions
       FROM study_sets s WHERE s.owner = ? ORDER BY s.updated_at DESC`
  ).bind(deviceId).all();
  return results;
}
