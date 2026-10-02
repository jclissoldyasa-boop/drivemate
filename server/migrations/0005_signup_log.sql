-- Short-lived list of new accounts for the owner's weekly signup summary. Rows are deleted after 8 days.
CREATE TABLE signup_log (created INTEGER NOT NULL, method TEXT NOT NULL, name TEXT NOT NULL DEFAULT '');
