-- Stage 10: the master sheet and the free engine, per-player memory and
-- difficulty ratings, wrong answers players fall for, reports, reusing
-- identical notes, offered top-ups, reworded engine questions, topic sets,
-- and a lifetime spending cap per account.

ALTER TABLE study_sets ADD COLUMN sheet TEXT;                 -- JSON master sheet (questions.js)
ALTER TABLE study_sets ADD COLUMN source_hash TEXT;           -- fingerprint of the notes, to reuse identical uploads
ALTER TABLE study_sets ADD COLUMN public INTEGER NOT NULL DEFAULT 0;   -- a topic set anyone can add
ALTER TABLE study_sets ADD COLUMN topup TEXT;                 -- '' | 'running'
CREATE INDEX study_sets_hash ON study_sets(source_hash);
CREATE INDEX study_sets_public ON study_sets(public);

ALTER TABLE questions ADD COLUMN rating REAL;                 -- difficulty from play (higher = harder); starts from diff
ALTER TABLE questions ADD COLUMN reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN origin TEXT NOT NULL DEFAULT 'core';  -- core | topup | fix

ALTER TABLE gen_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'make';     -- make | topup | fix | sheet
ALTER TABLE gen_runs ADD COLUMN batch_id TEXT;                -- a top-up's Batch API id while it runs

-- what each player has been asked, by question id (core 'q:…' or engine 'e:…')
CREATE TABLE seen (
  player TEXT NOT NULL,
  set_id TEXT NOT NULL,
  qkey   TEXT NOT NULL,
  shown  INTEGER NOT NULL DEFAULT 0,
  right  INTEGER NOT NULL DEFAULT 0,
  last   INTEGER NOT NULL,
  PRIMARY KEY (player, qkey)
);
CREATE INDEX seen_player_set ON seen(player, set_id);

-- each player's level on each set
CREATE TABLE player_ratings (
  player TEXT NOT NULL,
  set_id TEXT NOT NULL,
  rating REAL NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player, set_id)
);

-- wrong answers players picked, so the engine uses believable ones more
CREATE TABLE wrong_picks (
  set_id TEXT NOT NULL,
  vkey   TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, vkey)
);

-- engine questions reworded by a free small model, keyed by the plain wording
CREATE TABLE rewordings (
  set_id TEXT NOT NULL,
  stem   TEXT NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (set_id, stem)
);

CREATE TABLE reports (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL,
  question_id TEXT NOT NULL,
  device      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  outcome     TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX reports_device ON reports(device, at);

UPDATE questions SET rating = 1300 + diff * 400 WHERE rating IS NULL;
