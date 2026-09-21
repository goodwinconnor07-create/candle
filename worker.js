/**
 * Candle accountability API.
 *
 * One record per shared candle, held in Workers KV. The owner's browser
 * holds a bearer token from creation and is the only writer; everyone else
 * (the watcher) only ever reads. Records expire on their own after 7 days —
 * nothing here is meant to be a permanent log.
 *
 * Routes:
 *   POST   /api/candles                create a candle, returns {id, token}
 *   GET    /api/candles/:id             read a candle (public, token stripped)
 *   POST   /api/candles/:id/heartbeat   owner check-in while burning
 *   POST   /api/candles/:id/stop        owner blows it out early
 *
 * Everything else falls through to the static site in /public.
 */

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MIN_MINS = 5;
const MAX_MINS = 120;
const NAME_MAX = 24;
const NOTE_MAX = 80;
const FLAME_IDS = ['amber', 'rose', 'violet', 'ocean', 'emerald', 'moonlight'];

function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init && init.headers) },
  });
}

function err(status, message) {
  return json({ error: message }, { status });
}

function newId() {
  // short, URL-safe, and not guessable enough to matter for something this low-stakes
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

function publicView(c) {
  // never hand the owner token to a reader
  const { token, ...rest } = c;
  return rest;
}

async function readCandle(env, id) {
  const raw = await env.CANDLES.get(`candle:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function writeCandle(env, id, candle) {
  await env.CANDLES.put(`candle:${id}`, JSON.stringify(candle), { expirationTtl: TTL_SECONDS });
}

function bearerToken(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}

async function handleCreate(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return err(400, 'bad json'); }

  const name = clean(body.name, NAME_MAX) || 'Someone';
  const note = clean(body.note, NOTE_MAX);
  const flameId = FLAME_IDS.includes(body.flameId) ? body.flameId : 'amber';

  let totalMs = Number(body.totalMs);
  if (!Number.isFinite(totalMs)) return err(400, 'bad totalMs');
  const mins = Math.min(MAX_MINS, Math.max(MIN_MINS, Math.round(totalMs / 60000)));
  totalMs = mins * 60000;

  const now = Date.now();

  // Trust the browser's own already-ticking endAt when it's sane, so the
  // delay between lighting the candle and actually sharing it doesn't hand
  // the watcher extra time the owner's own page doesn't have.
  const rawEndAt = Number(body.endAt);
  const endAt = Number.isFinite(rawEndAt) && Math.abs(rawEndAt - (now + totalMs)) < totalMs
    ? rawEndAt
    : now + totalMs;
  const startedAt = endAt - totalMs;

  const id = newId();
  const token = newToken();

  const candle = {
    id,
    name,
    note,
    flameId,
    totalMs,
    startedAt,
    endAt,
    status: 'burning', // 'burning' | 'blown_out'
    endedAt: null,
    lastSeenAt: now,
    token,
  };

  await writeCandle(env, id, candle);
  return json({ id, token, endAt: candle.endAt }, { status: 201 });
}

async function handleRead(env, id) {
  const candle = await readCandle(env, id);
  if (!candle) return err(404, 'not found');
  return json(publicView(candle));
}

async function handleHeartbeat(request, env, id) {
  const candle = await readCandle(env, id);
  if (!candle) return err(404, 'not found');
  const token = bearerToken(request);
  if (token !== candle.token) return err(403, 'wrong token');
  if (candle.status !== 'burning') return json(publicView(candle)); // nothing to do once stopped

  let body = {};
  try { body = await request.json(); } catch (e) { /* a plain heartbeat with no body is fine */ }

  const now = Date.now();
  candle.lastSeenAt = now;

  // the owner may have changed the length mid-burn; adopt it so a watcher stays in step
  const newEndAt = Number(body.endAt);
  const newTotalMs = Number(body.totalMs);
  if (Number.isFinite(newEndAt) && newEndAt > now && Number.isFinite(newTotalMs)) {
    const mins = Math.min(MAX_MINS, Math.max(MIN_MINS, Math.round(newTotalMs / 60000)));
    candle.totalMs = mins * 60000;
    candle.endAt = newEndAt;
  }

  // the owner may have changed the flame colour mid-burn; adopt it too
  if (FLAME_IDS.includes(body.flameId)) candle.flameId = body.flameId;

  await writeCandle(env, id, candle);
  return json(publicView(candle));
}

async function handleStop(request, env, id) {
  const candle = await readCandle(env, id);
  if (!candle) return err(404, 'not found');
  const token = bearerToken(request);
  if (token !== candle.token) return err(403, 'wrong token');

  if (candle.status === 'burning') {
    candle.status = 'blown_out';
    candle.endedAt = Date.now();
    candle.lastSeenAt = candle.endedAt;
    await writeCandle(env, id, candle);
  }
  return json(publicView(candle));
}

async function api(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','candles', id?, action?]

  if (parts[1] !== 'candles') return err(404, 'not found');

  if (parts.length === 2) {
    if (request.method === 'POST') return handleCreate(request, env);
    return err(405, 'method not allowed');
  }

  const id = parts[2];
  if (!id) return err(400, 'missing id');

  if (parts.length === 3 && request.method === 'GET') return handleRead(env, id);
  if (parts.length === 4 && parts[3] === 'heartbeat' && request.method === 'POST') {
    return handleHeartbeat(request, env, id);
  }
  if (parts.length === 4 && parts[3] === 'stop' && request.method === 'POST') {
    return handleStop(request, env, id);
  }

  return err(404, 'not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env);
      } catch (e) {
        return err(500, 'internal error');
      }
    }

    return env.ASSETS.fetch(request);
  },
};
