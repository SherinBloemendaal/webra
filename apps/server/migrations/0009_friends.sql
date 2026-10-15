-- Friends (docs/accounts-api.md 5.11, docs/security.md "Friends and
-- presence"). Only new tables: nothing existing changes. Rows of an account
-- go when it is deleted (src/accounts/routes-account.js, and the daily job
-- for every other way an account ends up deleted) and with the account row
-- when it is purged (ON DELETE CASCADE).

-- One row per pair of friends, the smaller user id first, so a pair exists once.
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,                -- unix milliseconds
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (user_b);

-- Open friend requests. `ignored`: the receiver ignored it, or it was never
-- shown to the receiver (it blocks the sender, or has too many requests);
-- the sender still sees it as waiting, so it cannot tell. Forgotten after
-- 30 days (src/accounts/cron.js).
CREATE TABLE IF NOT EXISTS friend_requests (
  from_user TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_user TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  ignored INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_user, to_user),
  CHECK (from_user != to_user)
);
CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests (to_user, ignored);
CREATE INDEX IF NOT EXISTS friend_requests_created ON friend_requests (created_at);

-- Blocks: `user_id` blocked `blocked_id` (no requests, invites or joins from them).
CREATE TABLE IF NOT EXISTS user_blocks (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id != blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked ON user_blocks (blocked_id);

-- The presence heartbeat of the open game (POST /api/account/presence): when
-- it was last heard, and since when the player is away (null: not away).
CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  seen_at INTEGER NOT NULL,
  away_since INTEGER
);
CREATE INDEX IF NOT EXISTS user_presence_seen ON user_presence (seen_at);
