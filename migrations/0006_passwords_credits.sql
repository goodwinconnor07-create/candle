-- Stage 9: accounts get passwords (email still verified with a code when
-- signing up), password resets by emailed code, and 3 free credits each.
-- Making a set costs one; a run that fails gives it back.
ALTER TABLE accounts ADD COLUMN pass_hash TEXT;                    -- pbkdf2$iterations$salt$hash
ALTER TABLE accounts ADD COLUMN credits INTEGER NOT NULL DEFAULT 3;
ALTER TABLE login_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'signin';   -- signup | reset
ALTER TABLE login_codes ADD COLUMN pending_hash TEXT;              -- the password a sign-up chose, until the code is checked
ALTER TABLE gen_runs ADD COLUMN account TEXT;                       -- whose credit the run used

-- wrong passwords, so one email can't be guessed at forever
CREATE TABLE login_fails (
  email TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX login_fails_email ON login_fails(email, at);
