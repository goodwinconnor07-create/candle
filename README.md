# Study Duel

Two-player study mini games. You play a simple game everyone already knows,
but every move has to be earned by answering a question right. Pool, chess and
battleships so far.

Live at https://candle-timer.candle-timer.workers.dev

## Older versions

- **Judge Mode and Debate Mode** (ten quick-fire questions marked by a judge,
  and Claude-graded superannuation debates) are kept on the
  `archive/judge-debate-modes` branch. That branch is the app exactly as it was
  before they were taken out, so either mode can be brought back from there.
- **The original candle race**, and the solo accountability candle before
  that, are on the `v1-accountability-candle` branch.

## Pool

8-ball on a portrait table, styled after iMessage pool. The catch: every shot
has to be earned. Before each shot the shooter gets a question, and only a
right answer unlocks the cue. A wrong answer, or running out the 10 seconds,
hands the table to the other player without a shot being taken. Sink one of
your own and you keep the turn, but the next shot needs another right answer.

Standard 8-ball otherwise: break from behind the line, the table stays open
until someone legally pots a ball, then it's solids against stripes. A scratch,
missing everything, or hitting the wrong group first is a foul and passes the
turn, and if the cue ball went down the other player gets ball in hand. Clear
your group, then sink the 8. Sink it early, or scratch on it, and you lose.
There's a 30 second shot clock once you've answered right.

Spin works like iMessage: tap the white ball under the cue slider and drag
the red dot to where the tip should land. Top spin follows through after
the first hit, back spin draws the cue ball back, and side spin throws it
left or right off the cushions.

Questions are single-digit addition and subtraction for now. The generator
lives in `makeQuestion()` in `worker.js` and is the one place to change to
make this about something you're actually studying.

The intro screen plays a looping demo: two random characters taking turns on
a small table, answering a sum before each shot. It's scripted in the page
and never talks to the server.

## Chess

Normal chess, with a question before every move. The catch is different from
pool's, because handing over a turn in chess would give the other player two
moves in a row, and that's usually game over. So turns always alternate.

- Before each move you get a question. A right answer lets you move.
- A wrong answer, or running out the 10 seconds, takes 15 seconds off your
  chess clock and gives you another question. You keep going until you get
  one right.
- Each player has a 5 minute clock. It runs through your questions and your
  move, and pauses for the second where the right answer is shown. Run out
  and you lose, unless your opponent has too little left to ever mate you,
  in which case it's a draw.
- Get 3 or more right in a row and the game shows you the best move (a blue
  arrow on the board, plus the move written out) for as long as the streak
  lasts. One wrong answer resets the streak to 0.

Checkmate, stalemate, castling, en passant and promotion all work as usual,
and so do draws by threefold repetition, the fifty-move rule and not enough
material.

The best move comes from Stockfish 19, the lite single-threaded build of
[Stockfish.js](https://github.com/nmrugg/stockfish.js) (about 1.8 MB, in
`public/stockfish/`). It runs in the mover's own browser as a background
worker and thinks for one second, so it never touches the server and costs
nothing per game. The room just says when the hint has been earned. The
engine starts loading when a chess match opens, and the browser caches it
after that.

If Stockfish can't load on a device, the small engine in `public/chess.js`
takes over (`public/hint-worker.js`). That engine also picks Tester's moves
on the server.

Stockfish is GPLv3. Its license is in `public/stockfish/Copying.txt` and its
source is at https://github.com/nmrugg/stockfish.js. To update it, take
`stockfish-*-lite-single.js` and `.wasm` from the `stockfish` npm package and
change `SF_URL` in `public/index.html`.

## Battleships

Normal battleships, with a question before every shot. Each side has a 10 by
10 sea and the usual fleet: a Carrier (5 squares), a Battleship (4), a Cruiser
(3), a Submarine (3) and a Destroyer (2).

- Before the match, both players lay out their fleets at the same time. Ships
  start in random spots: drag one to move it, tap it to turn it, or hit
  Shuffle for a fresh layout. Ships can sit side by side but can't overlap.
  Hit Ready when you're set. There are 90 seconds for this, and whatever's on
  the board when time runs out is locked in.
- Turns alternate, one shot each. Before you fire you get a question, and a
  right answer lets you pick a square. Tap it to aim and again (or hit Fire)
  to shoot. You get 20 seconds to fire once you've answered.
- A wrong answer, or running out the 10 seconds, doesn't cost you the shot.
  Instead one empty square on your board (no ship on it, and not already fired
  at) is marked red for your opponent, so they know not to bother with it.
  Then you get another question.
- Every third right answer in a row works the other way: one empty square on
  their board is marked blue for you. A wrong answer resets the streak.
- Hits, misses and sunk ships work as usual, and a sunk ship's outline shows on
  the board. Sink all five of theirs to win. Their whole fleet is shown at the
  end.

The board on screen follows the turn: their waters while you're firing, yours
while they are. The two tabs at the top switch between them any time, and each
tab shows that fleet's ships with the sunk ones greyed out in red.

The room keeps both fleets and only ever sends each player their own. The
other side's ships only go out once they're sunk, or when the match ends. The
rules live in `public/battleships.js`, shared by the room and the browser like
`chess.js`, and that file also picks Tester's shots: it finishes off a ship
it has hit before hunting on a checkerboard for the next one.

## Whose turn is it?

Every game puts a banner over the board that says whose turn it is, with that
player's character. It goes amber when it's yours. When the turn comes back
to you, "Your turn" flashes in the middle of the screen and phones give a
short buzz. While the other player answers, their question card is greyed out
and blurred under "Gus is answering", then revealed once they've answered so
you can see how they did. Tapping a choice, the board or the table during
their turn shows a short "It's Gus's turn" message instead of doing nothing.
Each match starts with a 3-2-1 that says who goes first.

## Starting a match

Pick a game (Pool, Chess or Battleships), hit **Go**, then choose who you're playing:

- **Invite a Friend** lets you send a link, or switch to **Get a code** for a
  6-digit code you can read out or text. Your friend opens the site, taps
  **Got a code? Join a match** under Go, and types it in. A code stops
  working once someone has joined with it, and after a day either way.
  Whoever joins picks a character and a name and hits **I'm ready**, and then
  your **Start the match** button comes alive. Only the player who created the match can start
  it, or rematch afterwards.
- **Play a Bot** is greyed out until pool has a proper bot.
- **Test Mode** skips setup and the lobby and puts you straight into a match
  against "Tester", a stand-in that answers and shoots on its own. A dashed
  "Test mode" tag stays on screen so it's never mistaken for a real match.

Only two people can be in a match. A third person opening the link is told it's
full. If either player refreshes or their phone locks, they land back in the
same match. The seat is held for 15 seconds, and after that the match is called
off. Leaving on purpose (hold the X for three seconds) ends it for both players
straight away.

## How it's built

One Cloudflare Worker, one Durable Object per match, no database. Join codes
get their own tiny Durable Object each (`JoinCode`), which just remembers
which match the code points at.

The Durable Object holds the only real copy of a match. Both browsers hold a
WebSocket to it, so a shot lands on both screens at once. The room simulates
every shot itself (`simulate()` in `pool.js`) and sends both phones the frames
to replay, so the two screens can't disagree about whether a ball dropped.
The 8-ball rules live in `judgeShot()` in the same file.

The answer to a live question is never sent to the browsers. It only goes out
once the question is resolved, so there's nothing in the page to read ahead.
Each player gets their own copy of the state (`sendState()`), which is how
battleships keeps the two fleets secret.

Rooms delete themselves a day after the last activity.

## Running it

```
npx wrangler dev        # local, with a real Durable Object
npx wrangler deploy     # push it live
```

There's no build step and no dependencies to install for the Worker itself.
`public/index.html` is the whole front end, `worker.js` is the backend, and
pool's table physics and 8-ball rules are split out into `pool.js`. Chess
rules and the hint engine are in `public/chess.js`, which sits in `public/`
because both the room and the browser load it.

## Tuning

The knobs are constants at the top of `worker.js` and `pool.js`:

| Constant | What it does |
| --- | --- |
| `QUESTION_MS` | time allowed per question |
| `AIM_MS` | shot clock once a question is answered right |
| `POOL_RESULT_MS` | pause on right or wrong before the shot or handover |
| `LEAVE_GRACE_MS` | how long a dropped player's seat is held |
| `CHESS_CLOCK_MS` | each player's chess clock |
| `CHESS_PENALTY_MS` | time off your chess clock for a wrong answer |
| `HINT_STREAK` | right answers in a row that unlock the best move |
| `SEA_PLACE_MS` | time to lay out a battleships fleet |
| `SEA_AIM_MS` | time to pick a square once a question is answered right |
| `SEA_STREAK` | right answers in a row that clear one of their squares |
| `MAX_SPEED` (pool.js) | how hard a full-power shot hits |
| `ROLL_DECEL`, `DRAG` (pool.js) | how quickly balls slow down |
| `CORNER_GAP`, `SIDE_GAP` (pool.js) | pocket sizes |

## Adding another mini game

`MODES` in `worker.js` lists the games. A new one needs an entry there, a card
in `#modeGrid` in `public/index.html`, and its own game loop in the room
alongside the others. The grid is three across and full now, so a fourth game
means taking `cols3` off it for a two by two grid (check it still fits a
360x640 phone). The lobby, test mode, leaving and the hold-to-quit button are
shared and don't need to change.
