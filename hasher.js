/*
 * Password hashing (PBKDF2-SHA256, 100,000 rounds: the most Workers allow).
 * It's slow on purpose, so it runs in this Durable Object, which has room
 * for it, rather than in the Worker's request.
 */
const ROUNDS = 100000;
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));

export async function hashPassword(pw, saltHex, rounds = ROUNDS) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256);
  return `pbkdf2$${rounds}$${hex(salt)}$${hex(bits)}`;
}

export async function checkPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const again = await hashPassword(pw, p[2], Number(p[1]));
  // compare without stopping at the first difference
  let diff = again.length ^ stored.length;
  for (let i = 0; i < Math.min(again.length, stored.length); i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

export class Hasher {
  async fetch(request) {
    const b = await request.json();
    const out = b.op === 'check' ? { ok: await checkPassword(String(b.pw), b.hash) } : { hash: await hashPassword(String(b.pw)) };
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  }
}

// from the Worker: the work happens in one of a few Hasher objects
export async function viaHasher(env, body) {
  const stub = env.HASHER.get(env.HASHER.idFromName('h' + Math.floor(Math.random() * 4)));
  const res = await stub.fetch('https://hasher/', { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}
