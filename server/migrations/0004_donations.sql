-- Donations made through Square. Only donations by signed-in users are recorded; card details stay with Square.
CREATE TABLE donations (
  order_id TEXT PRIMARY KEY,   -- Square order id from the payment link
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,     -- cents requested
  currency TEXT NOT NULL,
  created INTEGER NOT NULL,
  paid INTEGER                 -- cents Square confirmed, once paid
);
CREATE INDEX donations_user ON donations(user_id);

-- A confirmed donation of $5 or more pauses the donation reminder until this time.
ALTER TABLE users ADD COLUMN donor_until INTEGER;
