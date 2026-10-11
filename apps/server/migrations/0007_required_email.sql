-- Required email addresses (docs/accounts-api.md 2.1 and 4.2).
--
-- New accounts give an email address at signup. A Discord signup uses the
-- address Discord reports verified; without one, the address typed on the
-- signup form travels with the OAuth state until the callback.
ALTER TABLE oauth_states ADD COLUMN email TEXT;

-- Unverified addresses are no longer cleared after 7 days (an account keeps
-- its required address; it still claims nothing): instead, signups that stay
-- `pending_email` for 7 days expire (src/accounts/cron.js). Nothing to migrate.
