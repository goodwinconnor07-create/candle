-- Share codes: the owner of a set hands out a short code, and anyone who
-- types it gets their own copy of the set's questions (not its notes).
CREATE TABLE share_codes (
  code        TEXT PRIMARY KEY,          -- 6 characters, no look-alikes
  set_id      TEXT NOT NULL,
  owner       TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX share_codes_set ON share_codes(set_id, active);

-- every code lookup, so one browser can't try codes one after another
CREATE TABLE share_lookups (
  device      TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX share_lookups_device ON share_lookups(device, at);

-- a copy stays a copy even if the set it came from is deleted (inherited_from
-- is cleared then, since it points at that set)
ALTER TABLE study_sets ADD COLUMN copied INTEGER NOT NULL DEFAULT 0;
