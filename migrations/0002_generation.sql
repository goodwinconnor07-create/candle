-- Stage 4: making questions from a study set, and keeping the spending under a cap.

ALTER TABLE study_sets ADD COLUMN status      TEXT NOT NULL DEFAULT 'new';   -- new | generating | ready | failed
ALTER TABLE study_sets ADD COLUMN gen_started INTEGER;
ALTER TABLE study_sets ADD COLUMN gen_note    TEXT;                          -- shown to the player when a run fails
ALTER TABLE study_sets ADD COLUMN subject     TEXT;                          -- 2 to 4 words, from the model
ALTER TABLE study_sets ADD COLUMN templates   TEXT;                          -- JSON: wording the local engine fills in

-- Short facts pulled from the notes. The local engine turns these into extra
-- questions without calling the API: kind is def | when | list | num.
CREATE TABLE facts (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  a           TEXT NOT NULL,              -- term, event, group or what
  b           TEXT NOT NULL,              -- definition, date, member or value
  batch       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX facts_set ON facts(set_id, kind);

-- One row per generation run. This is both the cost ledger and what the daily
-- caps add up: a running job counts at its estimate, a finished one at what it
-- really cost (millionths of a dollar).
CREATE TABLE gen_runs (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  device      TEXT NOT NULL,
  started     INTEGER NOT NULL,
  finished    INTEGER,
  status      TEXT NOT NULL,              -- running | done | failed
  est_micro   INTEGER NOT NULL,
  cost_micro  INTEGER NOT NULL DEFAULT 0,
  detail      TEXT                        -- JSON: tokens and cost for each call
);
CREATE INDEX gen_runs_started ON gen_runs(started);
CREATE INDEX gen_runs_device ON gen_runs(device, started);

-- Where a device came from (hashed), so one network can't mint endless devices.
ALTER TABLE devices ADD COLUMN ip_hash TEXT;
CREATE INDEX devices_ip ON devices(ip_hash, created_at);
