-- Saved online games (docs/security.md, "Online saves").
--
-- The server keeps only what it needs to check a resume: the save point,
-- the state hash every player agreed on there, digests of the order frames
-- and of the game options, the map hash, and which accounts played which
-- seat. The save files themselves (options, map and orders) stay in the
-- players' browsers. Deleted after ONLINE_SAVE_RETENTION_MS (90 days), beyond
-- ONLINE_SAVES_PER_ACCOUNT (20) per account, and when a player's account is
-- purged.
CREATE TABLE IF NOT EXISTS online_saves (
  id TEXT PRIMARY KEY,                -- 16 hex
  created_at INTEGER NOT NULL,        -- unix milliseconds
  engine TEXT NOT NULL,               -- game version that made it (resumes need the same)
  title TEXT NOT NULL,                -- the session name
  ticks INTEGER NOT NULL,             -- ticks played at the save point
  state_hash TEXT NOT NULL,           -- the state hash every player reported there
  frames_digest TEXT NOT NULL,        -- SHA-256 of the order frames before the save point
  options_digest TEXT NOT NULL,       -- SHA-256 of the game options
  map_hash TEXT                       -- SHA-256 of the map file, NULL for a generated map
);
CREATE INDEX IF NOT EXISTS online_saves_created ON online_saves (created_at);

CREATE TABLE IF NOT EXISTS online_save_members (
  save_id TEXT NOT NULL REFERENCES online_saves (id) ON DELETE CASCADE,
  seat INTEGER NOT NULL,              -- game player index
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (save_id, seat)
);
CREATE INDEX IF NOT EXISTS online_save_members_user ON online_save_members (user_id);
