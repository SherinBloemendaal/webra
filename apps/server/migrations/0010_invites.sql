-- Invite codes, friend invites and the session directory's summary
-- (docs/contracts.md section 4, docs/security.md "Invite codes"). Only new
-- tables and one new nullable column: existing rows stay as they are.

-- Invite codes: six characters (packages/protocol INVITE_ALPHABET) naming
-- one session while its lobby is open, at most 2 hours. A replaced or
-- closed code keeps its row (expires_at in the past, so a lookup answers
-- "expired" instead of "unknown") until the daily job deletes it a day later.
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,                   -- Durable Object id (64 hex)
  created_at INTEGER NOT NULL,                -- unix milliseconds
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_codes_session ON invite_codes (session_id, expires_at);
CREATE INDEX IF NOT EXISTS invite_codes_expires ON invite_codes (expires_at);

-- A friend's invite into a lobby, with the lobby's code: one per pair, the
-- newest wins; it ends with the code.
CREATE TABLE IF NOT EXISTS friend_invites (
  from_user TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  to_user TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (from_user, to_user),
  CHECK (from_user != to_user)
);
CREATE INDEX IF NOT EXISTS friend_invites_to ON friend_invites (to_user, expires_at);
CREATE INDEX IF NOT EXISTS friend_invites_expires ON friend_invites (expires_at);

-- What the server list's detail panel and the friends list show about a
-- session (src/directory.js sessionSummary): players with team and colour,
-- spectators, the mode, a few options and the start time. JSON, or NULL for
-- rows written before this migration. Private sessions get directory rows
-- from now on too (public = 0, never listed) for invite codes and friends.
ALTER TABLE sessions ADD COLUMN summary_json TEXT;
