CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL,        -- pbkdf2$iterations$salt$hash
  recovery TEXT NOT NULL,    -- same format, hash of the recovery code
  created INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
-- One row per app document: "config" (vehicles, readings, expenses, settings) and one per month of trips.
CREATE TABLE docs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, doc_id)
);
CREATE TABLE attempts (
  key TEXT PRIMARY KEY,      -- "login:<email>" or "reset:<email>"
  count INTEGER NOT NULL,
  first INTEGER NOT NULL
);
