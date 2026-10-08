-- Accounts: an email that several browsers (devices) can sign in to. Each
-- account has a home device; every signed-in device acts as that one, so all
-- of the account's sets, caps and share codes stay in one place.
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  home_device TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
ALTER TABLE devices ADD COLUMN account TEXT;

-- one-time sign-in codes, stored hashed, good for 10 minutes and 5 tries
CREATE TABLE login_codes (
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  device      TEXT NOT NULL,
  expires     INTEGER NOT NULL,
  tries       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);
CREATE INDEX login_codes_device ON login_codes(device, created_at);

-- after a match on a friend's set, the guest gets a token that lets them keep
-- a copy of that set when they sign up
CREATE TABLE keep_tokens (
  token       TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL,
  expires     INTEGER NOT NULL
);
