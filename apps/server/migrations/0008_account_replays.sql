-- Replays saved in accounts (docs/accounts-api.md 5.10, docs/security.md
-- "Replays in your account").
--
-- The replay files themselves are gzip objects in the R2 bucket bound as
-- REPLAYS (key `replays/<user id>/<replay id>`); this table holds what the
-- account's list shows and the limits count. Rows go after
-- ACCOUNT_REPLAY_RETENTION_MS (30 days, src/accounts/cron.js), beyond
-- ACCOUNT_REPLAYS_MAX (100) or ACCOUNT_REPLAYS_BYTES_MAX (100 MiB of stored
-- objects) per account (the oldest first), when the player deletes one, and
-- when the account is deleted.
CREATE TABLE IF NOT EXISTS account_replays (
  id TEXT PRIMARY KEY,                -- 16 hex, random
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,        -- the object in the REPLAYS bucket
  created_at INTEGER NOT NULL,        -- uploaded, unix milliseconds
  expires_at INTEGER NOT NULL,        -- created_at + 30 days
  size INTEGER NOT NULL,              -- bytes of the stored (gzip) object: what the quota counts
  raw_size INTEGER NOT NULL,          -- bytes of the replay file
  content_hash TEXT NOT NULL,         -- SHA-256 of the replay file (one copy per account)
  engine TEXT NOT NULL,               -- game version that recorded it
  mode TEXT NOT NULL,                 -- skirmish, online or mission
  title TEXT NOT NULL,                -- the game's title
  map_name TEXT NOT NULL,             -- the map's name, the mission id or "Generated map"
  players TEXT NOT NULL,              -- JSON [{ name, type, faction, team }] (names of other players too)
  played_at INTEGER NOT NULL,         -- when the game started (the file's createdAt)
  ticks INTEGER NOT NULL,             -- length of the game
  result TEXT NOT NULL                -- won, lost, left, spectated or unknown (what the uploader's client saw)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_replays_hash ON account_replays (user_id, content_hash);
CREATE INDEX IF NOT EXISTS account_replays_user ON account_replays (user_id, created_at);
CREATE INDEX IF NOT EXISTS account_replays_expires ON account_replays (expires_at);

-- R2 objects to delete. Every removed row queues its object here (the
-- trigger below, so a cascade from a purged account does too); an upload
-- queues its object before writing it, with `ready_at` an hour ahead, and
-- takes it out again in the batch that adds the row. The Worker deletes
-- ready objects right after the change and the daily job retries whatever
-- is left, so an object outlives its row only until the next run.
CREATE TABLE IF NOT EXISTS replay_object_trash (
  r2_key TEXT PRIMARY KEY,
  ready_at INTEGER NOT NULL           -- unix milliseconds; 0: at once
);
CREATE INDEX IF NOT EXISTS replay_object_trash_ready ON replay_object_trash (ready_at);

CREATE TRIGGER IF NOT EXISTS account_replays_trash AFTER DELETE ON account_replays
BEGIN
  INSERT OR REPLACE INTO replay_object_trash (r2_key, ready_at) VALUES (old.r2_key, 0);
END;
