-- Required email addresses (docs/accounts-api.md 2.1 and 4.2).
--
-- New accounts give an email address at signup. A Discord signup uses the
-- address Discord reports verified; without one, the address typed on the
-- signup form travels with the OAuth state until the callback.
ALTER TABLE oauth_states ADD COLUMN email TEXT;

-- Unverified addresses are no longer cleared after 7 days (an account keeps
-- its required address; it still claims nothing): instead, signups that stay
-- `pending_email` for 7 days expire (src/accounts/cron.js). Nothing to migrate.

-- Deleted accounts claim neither their address nor their Discord account:
-- the address text and its verified flag stay for a restore (which checks
-- again), the Discord id moves to deleted_discord_id.
ALTER TABLE users ADD COLUMN deleted_discord_id TEXT;
UPDATE users SET deleted_discord_id = discord_id, discord_id = NULL, email_key = NULL WHERE status = 'deleted';

-- Only signups that have waited in `pending_email` since they were created
-- expire (src/accounts/cron.js): set at signup, cleared for good the first
-- time the status changes. Accounts that are pending_email today (none
-- while email was unavailable) never expire.
ALTER TABLE users ADD COLUMN unconfirmed_signup INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER IF NOT EXISTS users_unconfirmed_signup_ends AFTER UPDATE OF status ON users
  WHEN NEW.unconfirmed_signup = 1 AND NEW.status IS NOT OLD.status
BEGIN
  UPDATE users SET unconfirmed_signup = 0 WHERE id = NEW.id;
END;
