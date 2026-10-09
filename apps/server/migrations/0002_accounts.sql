-- Accounts, sessions, login methods, bans, site settings and the audit log
-- (docs/accounts-api.md). Times are unix milliseconds. Secrets (session ids,
-- email tokens, OAuth state) are stored only as SHA-256 hex.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                        -- 32 hex, random
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,          -- NFKC, lower case
  display_name TEXT NOT NULL,
  email TEXT,
  email_key TEXT UNIQUE,                      -- lower case
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('pending_email', 'pending_approval', 'active', 'deleted')),
  status_before_delete TEXT,
  flags INTEGER NOT NULL DEFAULT 0,           -- bit mask, packages/protocol ACCOUNT_FLAGS
  password_hash TEXT,                         -- hex
  password_salt TEXT,                         -- hex
  password_iterations INTEGER,
  password_peppered INTEGER NOT NULL DEFAULT 0,
  password_changed_at INTEGER,
  user_handle TEXT NOT NULL UNIQUE,           -- WebAuthn user.id, base64url of 32 random bytes
  discord_id TEXT UNIQUE,
  discord_username TEXT,
  discord_linked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  approved_at INTEGER,
  approved_by TEXT,
  username_changed_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_status ON users (status, created_at);
CREATE INDEX IF NOT EXISTS users_created ON users (created_at);
CREATE INDEX IF NOT EXISTS users_last_seen ON users (last_seen_at);
CREATE INDEX IF NOT EXISTS users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- Sign-in sessions (the game sessions directory is the older `sessions` table).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id_hash TEXT PRIMARY KEY,                   -- SHA-256 of the cookie value
  public_id TEXT NOT NULL UNIQUE,             -- 16 hex, for listing and revoking
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                -- absolute limit
  reauth_at INTEGER NOT NULL,                 -- last sign-in proof
  ip_hash TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  device_label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_used ON auth_sessions (last_used_at);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                        -- credential id, base64url
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,                   -- COSE key, base64url
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',      -- JSON list
  backed_up INTEGER NOT NULL DEFAULT 0,
  uv INTEGER NOT NULL DEFAULT 0,
  counter_error INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);

-- WebAuthn challenges: single use (deleted when consumed), 5 minutes.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,                        -- 32 hex
  challenge TEXT NOT NULL,                    -- base64url
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'reauth', 'register', 'signup')),
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  data TEXT,                                  -- JSON (signup: username, display name, user handle)
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry ON webauthn_challenges (expires_at);

-- Email links: verification, email change, password reset. Single use.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'change', 'reset')),
  email TEXT,                                 -- the address the link proves
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS email_tokens_expiry ON email_tokens (expires_at);

-- Discord OAuth state: single use, 10 minutes, bound to the OAuth cookie.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,                 -- SHA-256 of the OAuth cookie
  verifier TEXT NOT NULL,                     -- PKCE code verifier
  mode TEXT NOT NULL CHECK (mode IN ('login', 'signup', 'link', 'reauth')),
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  session_hash TEXT,                          -- the session that started link or reauth
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS settings_docs (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,                          -- JSON, packages/protocol validateSettingsDocument
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Last IP addresses per account (admins only; 90 days, at most 20 per account).
CREATE TABLE IF NOT EXISTS user_ips (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip TEXT NOT NULL,                           -- canonical text form
  ip_v INTEGER NOT NULL,                      -- 4 or 6
  ip_hex TEXT NOT NULL,                       -- fixed width hex (8 or 32) for range queries
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, ip)
);
CREATE INDEX IF NOT EXISTS user_ips_range ON user_ips (ip_v, ip_hex);
CREATE INDEX IF NOT EXISTS user_ips_seen ON user_ips (last_seen);

CREATE TABLE IF NOT EXISTS account_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  expires_at INTEGER,                         -- NULL: permanent
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS account_bans_user ON account_bans (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS ip_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cidr TEXT NOT NULL,                         -- normalized, host bits cleared
  ip_v INTEGER NOT NULL,
  start_hex TEXT NOT NULL,                    -- first address, fixed width hex
  end_hex TEXT NOT NULL,                      -- last address, fixed width hex
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS ip_bans_range ON ip_bans (ip_v, start_hex, end_hex);

-- Who is in which online session (for dropping banned players). Deleted when
-- the member leaves or the session ends; stale rows are purged daily.
CREATE TABLE IF NOT EXISTS game_presence (
  session_id TEXT NOT NULL,
  client INTEGER NOT NULL,
  user_id TEXT,
  ip_v INTEGER,
  ip_hex TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, client)
);
CREATE INDEX IF NOT EXISTS game_presence_user ON game_presence (user_id);
CREATE INDEX IF NOT EXISTS game_presence_ip ON game_presence (ip_v, ip_hex);
CREATE INDEX IF NOT EXISTS game_presence_updated ON game_presence (updated_at);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,                          -- JSON, packages/protocol mergeSiteSettings
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,                              -- NULL: the system
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,                  -- user | ipban | site
  target_id TEXT,
  target_label TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log (actor_id, at);
CREATE INDEX IF NOT EXISTS audit_target ON audit_log (target_type, target_id, at);
CREATE INDEX IF NOT EXISTS audit_action ON audit_log (action, at);

-- Who uploaded a map (NULL for anonymous uploads before accounts).
ALTER TABLE maps ADD COLUMN uploader_id TEXT REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS maps_uploader ON maps (uploader_id);
