# Study Duel

Two-player study mini games. You play a simple game everyone already knows,
but every move has to be earned by answering a question right. Pool is the
first one.

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

## Starting a match

Pick a game, hit **Go**, then choose who you're playing:

- **Invite a Friend** gives you a link to send. Whoever opens it picks a
  character and a name and hits **I'm ready**, and then your **Start the
  match** button comes alive. Only the player who created the match can start
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

One Cloudflare Worker, one Durable Object per match, no database.

The Durable Object holds the only real copy of a match. Both browsers hold a
WebSocket to it, so a shot lands on both screens at once. The room simulates
every shot itself (`simulate()` in `pool.js`) and sends both phones the frames
to replay, so the two screens can't disagree about whether a ball dropped.
The 8-ball rules live in `judgeShot()` in the same file.

The answer to a live question is never sent to the browsers. It only goes out
once the question is resolved, so there's nothing in the page to read ahead.

Rooms delete themselves a day after the last activity.

## Running it

```
npx wrangler dev        # local, with a real Durable Object
npx wrangler deploy     # push it live
```

There's no build step and no dependencies to install for the Worker itself.
`public/index.html` is the whole front end, `worker.js` is the backend, and
pool's table physics and 8-ball rules are split out into `pool.js`.

## Tuning

The knobs are constants at the top of `worker.js` and `pool.js`:

| Constant | What it does |
| --- | --- |
| `QUESTION_MS` | time allowed per question |
| `AIM_MS` | shot clock once a question is answered right |
| `POOL_RESULT_MS` | pause on right or wrong before the shot or handover |
| `LEAVE_GRACE_MS` | how long a dropped player's seat is held |
| `MAX_SPEED` (pool.js) | how hard a full-power shot hits |
| `ROLL_DECEL`, `DRAG` (pool.js) | how quickly balls slow down |
| `CORNER_GAP`, `SIDE_GAP` (pool.js) | pocket sizes |

## Adding another mini game

`MODES` in `worker.js` lists the games. A new one needs an entry there, a card
in `#modeGrid` in `public/index.html` (there's a locked "More games" card
holding the spot), and its own game loop in the room alongside pool's. The
lobby, test mode, leaving and the hold-to-quit button are shared and don't
need to change.
