# Candle Timer

A two-hour timer that looks like a candle burning down.

## Running it

**Just the timer, no accountability backend:** open `public/index.html` in a
browser. No build step, no dependencies.

**With the backend**, so a shared candle can show a friend that you stopped
it early: see [DEPLOY.md](DEPLOY.md). It's a single Cloudflare Worker; free
tier covers this comfortably.

## How it works

The candle starts unlit in a dark room. Click the wick to light it; the flame
catches, the room warms up, and the countdown starts — two hours by default,
or whatever length you pick under the candle. The wax
shrinks as the time runs down, so you can read the timer from across the room
without reading the numbers. When it reaches zero the flame goes out, a wisp of
smoke rises, and a soft two-note chime plays.

- **Click the wick** — light it, or blow it out again while it's burning.
- **Blow out** — pauses the countdown, keeping the time left.
- **Reset** — back to a full candle at the chosen length.
- **Change time** — opens a slider under the candle, 5 minutes to 2 hours in
  5-minute steps. Picking a length starts a fresh full candle; do it while the
  candle is lit and it keeps burning, just at the new length.
- **Flame colour** — six swatches: amber, rose, violet, ocean, emerald and
  moonlight. The choice drives the whole scene, not just the flame — the wick
  glow, the light thrown on the room and the wax, and the tint of the
  countdown all follow it.
- **Send to someone** — appears once the candle is lit. Put in your name and
  it gives you a message and a link to send: *"Kavi has started a candle for
  25 min"*. Whoever opens it watches the same candle burn down in real time,
  in the same colour, read-only.

State is kept in `localStorage`, including the burn length and flame colour
you chose, so a refresh or a closed tab won't lose your place.

## Sharing a candle

There are two kinds of link, and which one you get depends on whether the
backend (see DEPLOY.md) is reachable when you hit Copy or Send. You don't
choose; the app tries the live one first and falls back automatically.

**Live** (needs the Worker deployed). Lighting the candle creates a small
record — name, length, flame colour, an end time — on the server, identified
by an id in the link (`#w=...`). Your page checks in with it every 20
seconds while burning, so a watcher's page can poll the same record and find
out three things: the countdown, whether you deliberately blew it out, and
roughly how long it's been since you last checked in ("quiet for a moment" /
"last seen 4 min ago"). Only a deliberate blow-out — clicking Blow out or
Reset while it's burning — is ever shown as a failure. Going quiet is shown
as just that, quiet, since a locked phone or a closed laptop lid looks
identical to having given up, and punishing the first would punish the
behaviour the app is meant to encourage. Records expire after 7 days.

**Static, serverless fallback** (`#c=...`). If the Worker can't be reached —
not deployed yet, or offline — the whole candle is encoded straight into the
link, and the watcher's page rebuilds it locally. Both ends count down from
the same absolute timestamp, so they stay in sync without ever talking to
each other. The tradeoff: nothing can travel back up a link like this, so
the watcher sees the candle burning and sees it finish, but can't ever learn
that you blew it out early. Their page says so.

Either way: watching someone else's candle never touches your own saved
state, the watcher can't light, stop or reset anything, and nobody but you
holds the token that can stop your own candle — the link you share only
ever contains an id.

None of this proves you were actually studying. It proves a browser tab
stayed open and someone chose, or didn't choose, to click Blow out in front
of a friend. That friction is the actual mechanism; the tab is just what
makes it visible.
