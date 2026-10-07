-- gen_runs is the spending ledger the daily caps add up. It was set to be
-- deleted along with its study set, which would let someone reset the caps by
-- deleting their sets. Rebuild it without that link (SQLite can't drop a
-- foreign key in place).
CREATE TABLE gen_runs_new (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL,
  device      TEXT NOT NULL,
  started     INTEGER NOT NULL,
  finished    INTEGER,
  status      TEXT NOT NULL,
  est_micro   INTEGER NOT NULL,
  cost_micro  INTEGER NOT NULL DEFAULT 0,
  detail      TEXT
);
INSERT INTO gen_runs_new SELECT id, set_id, device, started, finished, status, est_micro, cost_micro, detail FROM gen_runs;
DROP TABLE gen_runs;
ALTER TABLE gen_runs_new RENAME TO gen_runs;
CREATE INDEX gen_runs_started ON gen_runs(started);
CREATE INDEX gen_runs_device ON gen_runs(device, started);
