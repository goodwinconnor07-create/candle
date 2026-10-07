# Study Duel — notes for Claude

Two-player study mini games: a familiar game where every move is earned by
answering a question right. Pool (8-ball) and chess so far. Live at
https://candle-timer.candle-timer.workers.dev. See README.md for how the game
plays and DEPLOY.md for deploy details.

## Layout

- `worker.js`: Cloudflare Worker plus the `GameRoom` Durable Object. One room
  per match holds the only real game state; both players talk to it over a
  WebSocket. `MODES` lists the games.
- `pool.js`: pool physics (`simulate()`), 8-ball rules (`judgeShot()`), and the
  test stand-in's shot picker (`botShot()`). The server runs every shot and
  sends frames for the browsers to replay.
- `public/chess.js`: chess rules, plus a small alpha-beta engine for the test
  stand-in and as a backup hint. Both the room and the browser import it,
  which is why it lives in `public/`.
- `public/stockfish/`: Stockfish 19 lite single-threaded (GPLv3, license
  alongside). The streak hint runs it in the player's browser, never on the
  server. If it fails to load, `public/hint-worker.js` runs the small engine
  instead. The full Stockfish build is ~99 MB, over Cloudflare's 25 MB asset
  limit, so stick with lite.
- `public/index.html`: the whole front end in one file (styles, SVG characters,
  script). No build step, no framework.
- Nothing else to install for the Worker; `wrangler` is the only dev dependency.

## Branches

- Default branch is `claude/sleepy-euler-3cj2mo`. Open PRs against that, not
  `main` (there isn't one).
- `archive/judge-debate-modes`: the app with Judge Mode and Debate Mode, before
  they were removed. Bring either back from there if asked.
- `v1-accountability-candle`: the original candle race / solo candle timer.

## Running and testing

```
npx wrangler dev       # local on http://localhost:8787, real Durable Object
```

- Test Mode (Go → Test Mode) plays solo against "Tester" with no second
  browser needed.
- For UI checks, Playwright with Chromium at `/opt/pw-browsers/chromium` works
  well: two browser contexts for a host and a guest.
- Stop the dev server with `pkill -f "wrangler dev"` as its own command; it
  exits non-zero and breaks anything chained after it.

## Deploying

```
npx wrangler deploy
```

Needs `CLOUDFLARE_API_TOKEN` in the environment. Never commit the token or
write it into any file. The usual flow the owner wants: commit, push, open a
PR to the default branch, merge, deploy, then check the live site.

## Things to keep in mind

- Characters live in `CHAR_LIST` (front end) and `CHARS` (server). A new
  character has to go in both, or the server silently refuses the guest's
  ready message. `bot` is server-assigned only, for the test stand-in.
- Never send a live question's answer index to the browsers; it only goes out
  once the question is resolved.
- Chess: a wrong answer costs clock time and asks again, it never hands over
  the move (two moves in a row decides most games). Don't use `Date.now()`
  for time limits on searches inside the Worker, because it doesn't advance
  while code runs. Pass a node budget instead, like `botMove()` does.
- The page never scrolls (`html, body` are `overflow:hidden`, body is
  `100dvh`). Every screen has to fit, down to a 360x640 phone. Pool sizes its
  table in `poolResize()` and chess sizes its board in `chessResize()` from
  the space left over, so anything added above or below them is accounted
  for automatically. Check new screens at 360x640 and 1280x720.
- Match the existing style: dark "soot" background, tallow text, amber accent,
  Fraunces serif for headings, the iMessage-inspired pool table.

## How the owner likes replies

- Plain language at about a 12th grade level, with contractions and varied
  sentence length.
- No buzzwords (e.g. "game-changer", "delve", "fascinating", "tapestry",
  "streamline", "important to note").
- Don't default to lists of exactly three examples.
