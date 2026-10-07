-- WebRA D1 schema: session directory, uploaded maps, HTTP rate limits.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- Durable Object id (64 hex)
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  public INTEGER NOT NULL,            -- 0 or 1
  locked INTEGER NOT NULL,            -- 1 when a password is set
  players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  map_json TEXT,                      -- {id, name, hash, modded} or NULL for a generated map
  version TEXT NOT NULL,
  state TEXT NOT NULL,                -- lobby | game
  updated_at INTEGER NOT NULL         -- unix milliseconds
);
CREATE INDEX IF NOT EXISTS sessions_listing ON sessions (public, state, updated_at);

CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,                -- 16 hex
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  players INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE,          -- sha256 of the canonical JSON
  modded INTEGER NOT NULL,
  json TEXT NOT NULL,                 -- canonical JSON
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL         -- unix milliseconds
);
CREATE INDEX IF NOT EXISTS maps_created ON maps (created_at);

-- Fixed-window counters keyed by purpose and a hash of the client IP.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  win INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_win ON rate_limits (win);
