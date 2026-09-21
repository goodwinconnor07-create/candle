# Candle Timer

A two-hour timer that looks like a candle burning down.

Open `index.html` in a browser — no build step, no dependencies, one file.

## How it works

The candle starts unlit in a dark room. Click the wick to light it; the flame
catches, the room warms up, and the countdown starts at 2:00:00. The wax
shrinks as the time runs down, so you can read the timer from across the room
without reading the numbers. When it reaches zero the flame goes out, a wisp of
smoke rises, and a soft two-note chime plays.

- **Click the wick** — light it, or blow it out again while it's burning.
- **Blow out** — pauses the countdown, keeping the time left.
- **Reset** — back to a full candle at 2:00:00.

State is kept in `localStorage`, so a refresh or a closed tab won't lose your
place. A candle left burning keeps burning in real time while the page is shut.
