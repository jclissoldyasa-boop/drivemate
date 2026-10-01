CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,
  message TEXT NOT NULL,
  contact TEXT,              -- optional reply email; never published
  account_email TEXT,        -- set when the reporter was signed in
  diag TEXT,                 -- JSON: app version, platform, sync state, recent errors
  issue_url TEXT
);
