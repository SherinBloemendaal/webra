-- Security review fixes (docs/security.md, "Accounts review").
--
-- Unverified email addresses no longer claim their address: email_key (the
-- unique key) is set only once the address is verified, and unverified
-- addresses expire (email_set_at, cleared by the daily job after 7 days).
ALTER TABLE users ADD COLUMN email_set_at INTEGER;
UPDATE users SET email_set_at = created_at WHERE email IS NOT NULL;
UPDATE users SET email_key = NULL WHERE email_verified = 0;

-- Password sign-in failures per account across all networks: an escalating
-- delay instead of a hard lock (networks the account signed in from before
-- are exempt), so nobody else can keep the owner out.
ALTER TABLE users ADD COLUMN login_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN login_failed_at INTEGER;
ALTER TABLE users ADD COLUMN login_delay_until INTEGER;

-- Signing in no longer counts as a re-authentication: only an explicit one
-- (password, passkey with user verification, Discord) does.
UPDATE auth_sessions SET reauth_at = 0;

-- Rate limit counters are keyed with HMAC(IP_HASH_SALT) now: the old keys are useless.
DELETE FROM rate_limits;
