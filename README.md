# Candle Timer

A two-hour timer that looks like a candle burning down.

Open `index.html` in a browser — no build step, no dependencies, one file.

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

There's no server. The whole candle — name, end time, length, colour — is
encoded into the link itself, and the watcher's page rebuilds it locally.
Both ends count down from the same absolute timestamp, so they stay in sync
without ever talking to each other.

That also sets the limit. The watcher sees the candle burning and sees it
finish, but **cannot see if you blow it out early** — nothing can travel back
up the link. Their page says so plainly rather than implying it's proof. The
same goes for changing the length after you've shared: the link they hold
keeps the end time it was made with.

Watching someone else's candle never touches your own saved state, and the
watcher can't light, stop or reset anything.

Making that last step work — your friend actually seeing you stop — needs a
small backend, which isn't built yet. A candle left burning keeps burning in real time while the page is shut.
