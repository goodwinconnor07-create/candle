# Study Duel — notes for Claude

Two-player study mini games: a familiar game where every move is earned by
answering a question right. Pool (8-ball), chess, battleships, Towers (a Clash
Royale-style tower battle) and mini golf so far. Live at
https://candle-timer.candle-timer.workers.dev. See README.md for how the game
plays and DEPLOY.md for deploy details.

## Layout

- `worker.js`: Cloudflare Worker plus the `GameRoom` Durable Object. One room
  per match holds the only real game state; both players talk to it over a
  WebSocket. `MODES` lists the games. `sendState()` builds a separate
  snapshot for each seat, so `snapshot(role)` can hide things from one player.
  `JoinCode` is a second, tiny Durable Object, one per 6-digit join code,
  mapping it to a room id. The host asks for one from the lobby; it's let go
  as soon as the guest seat is taken.
- `questions.js`: where every question comes from. Games call `nextQ(role)` on
  the room, which gives each player a `Feed` over a source (maths today, study
  sets later). Questions carry a hidden `diff` and `why`; snapshots only ever
  copy `text` and `choices` (and `answer` once resolved), so players never see
  a difficulty ranking.
- `library.js` and `migrations/`: the D1 database (`DB` binding, named
  `study-duel`): anonymous devices, study sets, source text chunks and
  generated questions. Live matches never live here. A device is a secret the
  browser keeps (`POST /api/device`), stored only as a SHA-256. Schema changes
  go in a new numbered file in `migrations/`, applied with
  `npx wrangler d1 migrations apply study-duel --remote` before deploying.
- `public/pool.js`: pool physics (`simulate()`), 8-ball rules (`judgeShot()`),
  the shot-message check both sides use (`shotFrom()`), and the test
  stand-in's shot picker (`botShot()`). The room decides every shot and sends
  its inputs (`T.shot`), not frames. Both browsers run the same `simulate()`
  at 240 recorded frames a second, and the shooter's browser runs it the
  instant they let go. Keep `simulate()` to `+ - * /` and `Math.sqrt`, with
  no randomness, so every engine gets the same bits. The browser logs a
  console warning if its run ever ends somewhere the room's didn't.
- `public/chess.js`: chess rules, plus a small alpha-beta engine for the test
  stand-in and as a backup hint. Both the room and the browser import it,
  which is why it lives in `public/`.
- `public/battleships.js`: battleships rules (fleet, placement checks, random
  layouts) and Tester's shot picker. Shared by the room and the browser, like
  `chess.js`.
- `public/stockfish/`: Stockfish 19 lite single-threaded (GPLv3, license
  alongside). The streak hint runs it in the player's browser, never on the
  server. If it fails to load, `public/hint-worker.js` runs the small engine
  instead. The full Stockfish build is ~99 MB, over Cloudflare's 25 MB asset
  limit, so stick with lite.
- `towers.js`: the Towers battle, run by the room ten times a second
  (`step()`), plus `world()` for the compact picture both browsers get, and
  Tester's card picker (`botPlay()`).
- `public/towers-cards.js`: Towers cards, arena geometry, tower stats and the
  drop rules (`placeOk()`), shared by the room and the browser.
- `public/golf.js`: mini golf courses (rows of characters in `COURSE`),
  ball physics (`simulate()`, putts and 45-degree chips), the fog
  (`reveal()`), the stroke check (`shotFrom()`) and Tester's picker
  (`botShot()`). Shared by the room and the browser, with the same rule as
  `pool.js`: only `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, no
  randomness, so every engine lands on the same bits.
- `public/index.html`: the whole front end in one file (styles, SVG characters,
  script). No build step, no framework. Towers card art is the `ART` table
  in the script, drawn in the same style as the player characters.
- Nothing else to install for the Worker; `wrangler` is the only dev dependency.

## Branches

- Default branch is `claude/sleepy-euler-3cj2mo`. Open PRs against that, not
  `main` (there isn't one).
- `archive/judge-debate-modes`: the app with Judge Mode and Debate Mode, before
  they were removed. Bring either back from there if asked.
- `v1-accountability-candle`: the original candle race / solo candle timer.
- `archive/pre-revamp`: the whole app just before the UI revamp (home cards,
  lobby, design tokens). Roll back to it if the owner asks. The matching live
  deploy was Cloudflare version `4d78c9b8-4290-453f-b5f9-961597de2539`.

## Running and testing

```
npx wrangler dev       # local on http://localhost:8787, real Durable Object
```

- **Practice** on the home screen plays solo against "Tester" with no second
  browser needed (in Playwright: click `[data-mode="chess"]`, then
  `#introPractice`). **Invite a friend** is `#introGo`; with no saved profile it
  opens the setup screen first.
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

- Character art is the `char-*` SVG symbols (64x72). Shapes take the
  character's colours from `--ch-hair/skin/ink/shirt`; light, shade and detail
  are constant-colour overlays using the shared gradients in `#chDefs`
  (a gradient can't pick up a CSS variable through `<use>`). `kingSprite()`
  copies a symbol plus `#chDefs` into an image for the Towers king.
- Characters live in `CHAR_LIST` (front end) and `CHARS` (server). A new
  character has to go in both, or the server silently refuses the guest's
  ready message. `bot` is server-assigned only, for the test stand-in.
- Never send a live question's answer index to the browsers; it only goes out
  once the question is resolved.
- Battleships: never put the other player's fleet in a snapshot. Their ships
  only go out once sunk, or when the match is over. A wrong answer gives away
  one of your empty squares and asks again; it never costs the shot.
- Chess: a wrong answer costs clock time and asks again, it never hands over
  the move (two moves in a row decides most games). Don't use `Date.now()`
  for time limits on searches inside the Worker, because it doesn't advance
  while code runs. Pass a node budget instead, like `botMove()` does.
- Towers is played in rounds: a study round (arena frozen, each player
  answers their own 4 questions; right answers are the only source of
  elixir), then a live battle round with no questions in it. Don't put
  questions back into the live battle: playtesting showed people stop
  answering, and real lecture questions need undivided attention. Each
  player's question, hand and elixir are sent only to them (`towersSend()`).
  The battle steps on a fixed 100ms tick, only during battle rounds; keep `step()` cheap (it runs in
  well under a millisecond with ~40 troops). For balance changes, run bots
  against each other in Node with `newBattle()`, `botPlay()` and `step()`
  before trying it in the browser.
- Mini golf: turns alternate like pool. A wrong answer adds a penalty stroke
  and asks the same player again; it never hands over the turn. Water and
  out of bounds cost a stroke and the ball goes back where it was hit from.
  The fog (`seen`) is shared by both players. When changing a course, run
  Tester on it in Node (`botShot()` + `simulate()`) to check it plays in
  roughly par.
- The page never scrolls (`html, body` are `overflow:hidden`, body is
  `100dvh`). Every screen has to fit, down to a 360x640 phone. Pool sizes its
  table in `poolResize()`, chess its board in `chessResize()` and battleships
  its sea in `seaResize()`, golf its course view in `golfResize()`, from the space left over, so anything added above or below them is accounted
  for automatically. Check new screens at 360x640 and 1280x720.
- Match the existing style: dark "soot" background, tallow text, amber accent,
  the system font (SF Pro on Apple devices) for all interface text, Fraunces
  only for the Study Duel wordmark, and the iMessage-inspired pool table. Each
  game has its own colour pair (`--g1`/`--g2` on `[data-mode]`).
- Use the design tokens in `:root` (`--r-*` corners, `--s*` spacing,
  `--ease-out`, `--spring`, `--press`, `--settle`) rather than new one-off values.
  Every tappable control needs a pressed state (`scale` dips while `:active`)
  and at least a 44px touch area. Animate `scale`, `translate` and `opacity`,
  never layout, and keep `prefers-reduced-motion` working.
- The home screen is `#scIntro`: game cards in `#games` (a sideways
  scroll-snap strip), `pickGame()` and `scrollToGame()` to choose one. Screens
  before a game put their main button in a `.dock` at the bottom. `show()` slides
  screens by their `DEPTH` and fades games in.
- History: screens opened inside the app (`pushSub()`: join code, profile,
  deck) and a match (`{ sd: 'match' }`) get their own history entry, so the
  phone's back gesture moves through the app. A live match ignores back and
  says to hold the X. `goHome()` steps back out of our entry or clears the link
  in place. Don't add `location.hash =` navigations; use `replaceState`/
  `pushState` with the same `sd` state.
- Lobby leaving: the browser sends `leave` when backing out of a lobby
  (`toIntro()`). A guest leaving frees the seat and the host gets a new code;
  a host leaving marks the lobby `closed` and the guest gets `t:'closed'`. A
  dropped socket only changes the guest's `here` (connected) flag, so a host
  switching apps to share the link keeps the lobby.
- Ids must be unique across the whole page, including SVG gradient ids in the
  home card scenes (`buildScenes()`): a gradient called `scSea` once hid the
  Battleships screen from `$('scSea')`.
- The app icon is `public/icons/mark.svg` (rendered to the PNGs beside it) and
  `public/manifest.webmanifest` makes it installable.

## How the owner likes replies

- Plain language at about a 12th grade level, with contractions and varied
  sentence length.
- No buzzwords (e.g. "game-changer", "delve", "fascinating", "tapestry",
  "streamline", "important to note").
- Don't default to lists of exactly three examples.
