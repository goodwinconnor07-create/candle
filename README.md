# Study Duel

Two-player study mini games. You play a simple game everyone already knows,
but every move has to be earned by answering a question right. Pool, chess,
battleships, Towers and mini golf so far.

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

## Towers

A tower battle after Clash Royale, with its own cast. Each side has a king
tower and two lantern towers, with a river and two bridges between. You win
by knocking towers down: one crown per lantern tower, all three for the king.

The twist: elixir only comes from answering questions, and the match is
played in rounds so studying and fighting never compete for your attention.

- **Study round**: both arenas freeze and each player gets 4 questions to
  answer at their own pace. Each right answer banks 2.5 elixir (a perfect round
  fills the bar), plus 0.5 from your third right answer in a row on. A wrong
  answer shows the right one and moves on. The round ends when both players
  are done, or after 30 seconds. Whoever finishes first waits for the other.
- **Battle round**: 25 seconds of live battle with no questions at all. Spend
  what you banked; anything left carries over, up to 10.
- 7 rounds, about 3 minutes of battle. Most crowns wins. If it's level, up to
  2 overtime rounds where the next tower to fall decides it, then whoever's
  weakest tower has less health left loses. The last 2 regular rounds and the
  overtime rounds are "rush" rounds: every right answer is worth 1 more.
- You start with no elixir, so the first study round sets the pace.
- Your deck is 8 cards. You hold 4 and can see the next one. A played card
  goes to the back of the queue, so the order cycles.
- In a battle round, tap a card, then tap the arena, or drag the card straight
  on. Troops and buildings go on your side of the river. Once you take a
  lantern tower, the gap it leaves on their side opens up too. Spells go
  anywhere.

The rounds are there so harder questions work: a study round can be as long
as the questions need (`STUDY_MS`) without the battle punishing you for
reading.

How troops think, the way Clash Royale's do: each one goes for the nearest
enemy it's allowed to hit within sight, and with nothing in sight it walks
to the nearest enemy tower. Once it's swinging at something it stays on it.
Ground troops need a bridge to cross the river. Tower-chasers ignore troops
entirely, so a building in their path pulls them off course. A king tower
sleeps until it's hit or loses a lantern tower.

The cards, all original characters:

| Card | Elixir | What it does |
| --- | --- | --- |
| Hall Monitor | 3 | Sturdy melee tank for one lane |
| Pencil Pushers | 3 | Two ranged troops that hit air and ground |
| Paper Planes | 3 | Three fast flyers |
| Doodles | 3 | Ten small scribbles that swarm |
| Janitor | 4 | Spins a mop and hits everything around him |
| Chem Whiz | 5 | Ranged splash, air and ground |
| Bookstack | 5 | Slow, huge, and only goes for towers |
| Skater | 4 | Very fast, jumps the river, goes for towers |
| Paper Lantern | 5 | Flies to a tower and drops wax on it; bursts when popped |
| Stapler | 3 | Turret for ground troops; pulls tower-chasers; lasts 30s |
| Pop Quiz | 4 | Area damage, launched from your king tower |
| Eraser | 2 | Rolls forward, hitting and shoving ground troops |
| Detention | 4 | Freezes everything in the circle for 4s, towers too |
| Coffee Break | 2 | Your troops in the circle move and hit 35% faster |

Spells only do 30% of their damage to towers. The starter deck is Hall
Monitor, Pencil Pushers, Paper Planes, Doodles, Bookstack, Chem Whiz, Pop Quiz
and Eraser. Pick your own 8 with **Edit deck** before a match; it's kept in
your browser.

Under the hood the room runs the whole battle (`towers.js`) ten times a
second and sends both phones a small picture of it, which they draw smoothly
between updates. Each player's question, hand and elixir only go to that
player. The cards, the arena and the drop rules live in
`public/towers-cards.js`, shared by the room and the browser. In Practice,
Tester plays a random deck, answers about three in four right, defends what
crosses the river and pushes a lane when it has saved up.

## Mini golf

Top-down mini golf over three holes, picked at random from six. The courses
are much bigger than the screen, and they start out hidden under fog. The
camera follows the ball, and the fog lifts wherever a ball has been, so you
find out what's round the corner as you play. A flag on the edge of the view
always points at the cup, with how far away it is.

- Players take turns, one stroke each, and a right answer earns the stroke.
  A wrong answer, or running out the 10 seconds, adds a penalty stroke and
  asks you again. Once a player has holed out, the other keeps going alone.
- To swing, drag back from anywhere on the course and let go. The further
  you pull, the harder you hit. You get 30 seconds once you've answered, and
  running out costs a stroke.
- Two clubs. **Putt** rolls the ball along the ground. **Chip** lofts it at 45
  degrees, so it flies in a real arc: its shadow slides away as it climbs, it
  sails over walls and water if it's high enough, then bounces and rolls. The
  aim preview shows a chip's flight and a ring where it first comes down.
- Sand grabs the ball and kills a landing dead. Slopes (the chevrons) pull the
  ball downhill. Orange bumper posts bounce it back. Water, or anything off
  the course, is a penalty stroke, and the ball goes back where you hit it
  from.
- A ball that comes in too fast lips out of the cup. A slow one near the edge
  falls in. Eight strokes on a hole is the most you can take, and then you
  pick up.
- The better score on a hole tees off first on the next. Fewest strokes over
  the three holes wins, and a tie is a tie.

Like pool, the room decides every stroke and sends its inputs, and both
browsers run it through the same `simulate()` in `public/golf.js`. The player
who swings sees their ball leave straight away. The courses are drawn as rows
of characters at the top of that file, which also has Tester's shot picker:
it tries a spread of directions, strengths and both clubs, keeps whichever
leaves it closest to the cup by the route a ball would have to roll, then
wobbles the aim a little.

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

The home screen is a row of game cards you swipe through: Pool, Chess,
Battleships, Towers and Mini Golf. Whichever card is in the middle is the game
you'll play. Your character sits in the top left (tap it to change your name or
character), and **Join** in the top right takes a 6-digit code.

- **Invite a friend** opens the lobby straight away if your name and character
  are saved, or asks for them first. **Share invite** sends a link through the
  phone's share sheet (on a computer it's **Copy link**). A 6-digit code shows
  underneath for reading out. Your friend taps **Join** on the home screen and
  types it in. A code stops working once someone has joined with it, and after
  a day either way. Whoever joins picks a character and a name and hits **I'm
  ready**, and then your **Start the match** button lights up. Only the player
  who created the match can start it. Either player can rematch afterwards.
- **Practice** puts you straight into a match against "Tester", a stand-in that
  answers and plays on its own. A dashed "Practice" tag stays on screen so it's
  never mistaken for a real match.

On an iPhone, **Add to Home Screen** (from Safari's Share menu) installs it as a
full-screen app with its own icon. Safari suggests this once.

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
every shot itself (`simulate()` in `public/pool.js`) and sends both phones the
shot: where the balls started, plus the aim, power and spin. Each browser runs
that through the same `simulate()` and draws it at the screen's own frame
rate. The shooter's browser doesn't even wait. It runs the shot the moment
they let go, while the cue stick lunges at the ball. `simulate()` only uses
basic arithmetic and square roots, which come out the same in every browser,
so every copy ends exactly where the room's does. The browsers still snap to
the room's final layout at the end, so the two screens can't disagree about
whether a ball dropped. The 8-ball rules live in `judgeShot()` in the same
file.

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
pool's table physics and 8-ball rules are split out into `public/pool.js`.
Chess rules and the hint engine are in `public/chess.js`. Both sit in
`public/` because the room and the browser load them. The Towers battle is in
`towers.js`, and its cards and arena in `public/towers-cards.js` for the
same reason. Mini golf's courses and physics are in `public/golf.js`.

## Tuning

The knobs are constants at the top of `worker.js` and `public/pool.js`:

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
| `ELIXIR_PER_RIGHT`, `ELIXIR_STREAK`, `ELIXIR_RUSH` | Towers elixir per right answer, the streak bonus and the rush bonus |
| `STUDY_QS`, `STUDY_MS` | Towers questions per study round, and the most a study round can last |
| `BATTLE_TICKS`, `ROUNDS`, `OT_ROUNDS`, `RUSH_ROUNDS` | Towers battle round length (tenths of a second), round counts |
| `CARDS`, `TOWER_STATS` (public/towers-cards.js) | every card's stats, and the towers' |
| `MAX_SPEED` (public/pool.js) | how hard a full-power shot hits |
| `ROLL_DECEL`, `DRAG` (public/pool.js) | how quickly balls slow down |
| `FOLLOW`, `NATURAL`, `SLIDE_ACC` (public/pool.js) | how strong follow and draw are, how much a plain shot rolls on, and how quickly the cue ball's path bends after a hit |
| `CORNER_GAP`, `SIDE_GAP` (public/pool.js) | pocket sizes |
| `GOLF_HOLES`, `GOLF_AIM_MS` | holes per golf match, and the time to swing |
| `PUTT_MAX`, `CHIP_MAX` (public/golf.js) | how hard a full putt and a full chip are |
| `ROLL`, `SLOPE`, `G`, `LAND` (public/golf.js) | rolling resistance on turf and sand, slope pull, gravity, and what a landing keeps |
| `MAX_STROKES` (public/golf.js) | strokes on one hole before you pick up |
| `COURSE` (public/golf.js) | the holes themselves, drawn as rows of characters |

## Adding another mini game

`MODES` in `worker.js` lists the games. A new one needs an entry there, a card
in `#modeGrid` in `public/index.html`, and its own game loop in the room
alongside the others. The grid is two columns; an odd card out on the last
row spans both. Check it still fits a 360x640 phone. The lobby, test
mode, leaving and the hold-to-quit button are shared and don't need to change.
