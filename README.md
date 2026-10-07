# Candle Race

Two friends, the same questions, two candles burning down. Answer one right
and your opponent's candle flares up and burns faster. Answer one wrong and
yours does instead. Last flame still burning wins.

Live at https://candle-timer.candle-timer.workers.dev

The earlier version of this project — a solo candle that burns down as an
accountability timer, with shareable links so a friend could watch — is kept
on the `v1-accountability-candle` branch.

## The rules

- Both players see the same question at the same time, with **10 seconds** to
  answer. Four choices; 1-4 on the keyboard works too.
- **Right** → the *other* candle burns at triple speed for about four seconds.
- **Wrong, or out of time** → *your* candle burns fast instead. Running out
  the clock is treated exactly like getting it wrong.
- **Three right in a row** → you get wax back, capped at a full candle. The
  pips under your candle show how close you are.
- Both candles burn at the base rate the whole time regardless, so an evenly
  matched race still ends rather than stalling.
- First candle to run out loses. Both at once is a draw.

A candle holds three minutes of burn at the base rate, so a game usually runs
two to four minutes depending on how badly you're hurting each other.

Questions are single-digit addition and subtraction for now — enough to prove
the mechanic works. The generator lives in `makeQuestion()` in `worker.js` and
is the one place to change to make this about something you're actually
studying.

## Starting a race

One player opens the app, types a name, and hits **Start a race**. That gives
them a link to send. Whoever opens it sees who challenged them, enters their
own name and clicks **I'm ready** — at which point the first player sees
they're ready and the **Start the race** button comes alive. Only the player
who created the race can start it, or rematch afterwards.

Only two people can be in a race. A third person opening the link is told the
race is full. If either player refreshes or their phone locks, they land back
in the same race where they left it — the browser remembers which seat was
theirs, and the race carries on burning while they're gone.

## How it's built

One Cloudflare Worker, one Durable Object per race, no database.

The Durable Object holds the only real copy of a race: both wax levels, who's
burning fast and until when, the current question, and each player's streak.
Both browsers hold a WebSocket to it, so a hit lands on the other candle
straight away instead of waiting for a poll. It broadcasts wax levels four
times a second, and each browser smooths between those updates against its own
clock — no device clock is ever trusted, so a phone set three minutes fast
can't drift the two candles apart.

The answer to a live question is never sent to the browsers. It only goes out
once the round is resolved, so there's nothing in the page to read ahead.

Rooms delete themselves a day after the last activity.

## Running it

```
npx wrangler dev        # local, with a real Durable Object
npx wrangler deploy     # push it live
```

There's no build step. `public/index.html` is the whole front end and
`worker.js` is the backend, with pool's table physics and 8-ball rules split
out into `pool.js`.

## Tuning

The knobs are all constants at the top of `worker.js`:

| Constant | What it does |
| --- | --- |
| `START_WAX_MS` | how much candle each player starts with |
| `QUESTION_MS` | time allowed per question |
| `BURST_RATE` / `BURST_MS` | how much faster a hit candle burns, and for how long |
| `BURST_CAP_MS` | stops stacked hits from snowballing |
| `STREAK_N` / `HEAL_MS` | right answers needed to earn wax, and how much |


## Debate Mode

Three topics a match, drawn from live Australian superannuation arguments —
Division 296, super for housing, the preservation age, the 12% guarantee.
The app assigns you a side, you get three minutes and fifty words to argue
it, and the sides swap each round so nobody is stuck defending one line.

Both cases stay private until both are filed. Then Claude reads them and
scores each debater from 3 to 7 on their own merit, so you can both argue
well or both argue badly — it isn't a win-or-lose split. The judge works
through what you did well, then what let you down, then the grade.

A round the judge can't score is left out of the average rather than
guessed at, and both players are told why.

### Setting the key

Debate Mode needs an Anthropic API key, set as a Worker secret:

```
npx wrangler secret put ANTHROPIC_API_KEY
```

Until that's set the mode still runs, but every round comes back unscored
with the judge saying he hasn't been given his credentials. Roughly two
cents a match at current Opus pricing.

For local work, put the same key in a `.dev.vars` file (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Pool

8-ball on a portrait table, styled after iMessage pool. The catch: every shot
has to be earned. Before each shot the shooter gets a question, and only a
right answer unlocks the cue. A wrong answer, or running out the 10 seconds,
hands the table to the other player without a shot being taken. Sink one of
your own and you keep the turn, but the next shot needs another right answer.

Standard 8-ball otherwise: break from behind the line, the table stays open
until someone legally pots a ball, then it's solids against stripes. A scratch,
missing everything, or hitting the wrong group first is a foul and gives the
other player ball in hand. Clear your group, then sink the 8. Sink it early, or
scratch on it, and you lose. There's a 30 second shot clock once you've
answered right.

Spin works like iMessage: tap the white ball under the cue slider and drag
the red dot to where the tip should land. Top spin follows through after
the first hit, back spin draws the cue ball back, and side spin throws it
left or right off the cushions.

The room simulates every shot itself (`simulate()` in `pool.js`) and sends both
phones the frames to replay, so the two screens can't disagree about whether a
ball dropped. Pool is friends-only for now; the bot option is greyed out.

## Test Mode

For trying a mode out on your own. Pick any mode, hit Go, then **Test Mode**:
you skip setup and the lobby and go straight into a match against "Tester",
a stand-in that plays every mode, Pool included. Debate rounds are graded by
a stand-in judge instead of Claude (it scores on length and whether there's a
figure), so a test match never calls the API or spends tokens. A dashed
"Test mode" tag stays on screen so it's never mistaken for a real match.
