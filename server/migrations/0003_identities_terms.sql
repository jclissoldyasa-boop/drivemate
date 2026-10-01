-- Terms of Use / Privacy Policy acceptance, recorded per account.
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_accepted INTEGER;

-- Google / Facebook logins linked to an account. Accounts created this way have an empty pass and recovery.
CREATE TABLE identities (
  provider TEXT NOT NULL,      -- "google" or "facebook"
  subject TEXT NOT NULL,       -- the provider's user id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- One-time codes that hand a Google/Facebook sign-in back to the page or the Android app.
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
