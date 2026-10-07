-- Study Duel library: who owns what study material and the questions made from it.
-- Live matches stay in the GameRoom Durable Objects; this is only the long-lived stuff.

-- One row per browser until accounts exist. The browser keeps a secret and we
-- only store its SHA-256, so a leaked database can't be used to act as someone.
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,           -- short public id
  secret_hash TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- A study set is the master content. Questions are derived from it.
CREATE TABLE study_sets (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES devices(id),
  name        TEXT NOT NULL,
  inherited_from TEXT REFERENCES study_sets(id),   -- set this one was copied from, if any
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX study_sets_owner ON study_sets(owner);

-- The source text, in pieces. Each addition (first upload or later) is one
-- generation event, which is what credits will count in stage 9.
CREATE TABLE source_chunks (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  batch       INTEGER NOT NULL,           -- which upload/generation event added it
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX source_chunks_set ON source_chunks(set_id, seq);

-- Generated multiple-choice questions. Nothing here is edited by hand; a bad
-- one is retired and replaced from the source.
CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  chunk_id    TEXT REFERENCES source_chunks(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  choices     TEXT NOT NULL,              -- JSON array of 4 strings
  answer      INTEGER NOT NULL,           -- index into choices
  why         TEXT,                       -- one line, optional
  diff        REAL NOT NULL DEFAULT 0.5,  -- backend estimate, 0 to 1, never shown to players
  active      INTEGER NOT NULL DEFAULT 1,
  shown       INTEGER NOT NULL DEFAULT 0,
  right       INTEGER NOT NULL DEFAULT 0,
  batch       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX questions_set ON questions(set_id, active);
