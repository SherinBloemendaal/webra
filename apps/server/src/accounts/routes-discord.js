// Discord sign-in, signup, linking and re-authentication
// (docs/accounts-api.md, section 4.6).

import { emailKey, validEmail, validUsername } from '@webra/protocol';
import { cookieHeader, cookieName, HttpError, isReturnPath, json, parseCookies } from '../http.js';
import { randomInt, randomToken, sha256Hex } from '../crypto.js';
import { check, invalid } from './context.js';
import { queueAddressMail } from './verification.js';
import { rotate, statusAfterVerification } from './common.js';
import { authorizeUrl, DiscordError, fetchDiscordUser, OAUTH_COOKIE, OAUTH_TTL_MS, pkceChallenge } from './discord.js';
import { banOf, initialStatus, insertUser, uniqueViolation, userByDiscord, userByEmail, userByUsername, userById } from './users.js';
import { createSession, hasRecentReauth } from './sessions.js';
import { LIMITS, methodDisabled } from './routes-auth.js';
import { logError } from '../telemetry.js';

const MODES = ['login', 'signup', 'link', 'reauth'];
const DEFAULT_RETURN = '/account/';
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

async function requireDiscord(ctx) {
  const eff = await ctx.eff();
  if (!eff.services.discord) throw new HttpError(503, 'unavailable', 'Discord sign-in is not configured on this server.');
  if (!eff.login.discord) throw methodDisabled('Discord');
  return eff;
}

async function start(ctx) {
  const body = await ctx.body(['mode', 'returnTo', 'acceptPrivacy', 'email']);
  await ctx.assertIpAllowed();
  const eff = await requireDiscord(ctx);
  if (!MODES.includes(body.mode)) throw invalid('mode', 'Mode must be login, signup, link or reauth.');
  const returnTo = body.returnTo ?? DEFAULT_RETURN;
  if (!isReturnPath(returnTo)) throw invalid('returnTo', 'returnTo must be a path on this site.');
  await ctx.burst('discord', LIMITS.discordBurst);
  let userId = null;
  let sessionHash = null;
  // Signup only: the address to use when Discord reports no verified one (docs/accounts-api.md 4.6).
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (body.mode !== 'signup') throw invalid('email', 'An email address is only sent when signing up.');
    email = check(() => validEmail(body.email));
  }
  if (body.mode === 'signup') {
    if (!eff.registrationOpen) throw new HttpError(403, 'registration_closed', 'Signup is closed right now.');
    if (body.acceptPrivacy !== true) throw invalid('acceptPrivacy', 'Please accept the privacy notice.');
  }
  if (body.mode === 'link' || body.mode === 'reauth') {
    const user = await ctx.requireUser();
    const { session } = await ctx.auth();
    if (body.mode === 'link') {
      await ctx.requireReauth();
      if (user.discord_id) throw new HttpError(409, 'conflict', 'A Discord account is already linked.');
    } else if (!user.discord_id) {
      throw new HttpError(409, 'conflict', 'No Discord account is linked.');
    }
    userId = user.id;
    sessionHash = session.id_hash;
  }
  const state = randomToken();
  const verifier = randomToken();
  const binding = randomToken();
  await ctx.db
    .prepare(
      `INSERT INTO oauth_states (state_hash, binding_hash, verifier, mode, user_id, session_hash, return_to, expires_at, email)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(await sha256Hex(state), await sha256Hex(binding), verifier, body.mode, userId, sessionHash, returnTo, ctx.now + OAUTH_TTL_MS, email)
    .run();
  ctx.cookies.push(cookieHeader(ctx.request, OAUTH_COOKIE, binding, OAUTH_TTL_MS / 1000));
  return json({ url: authorizeUrl(ctx.env, ctx.origin, state, await pkceChallenge(verifier)) });
}

/** A username from a Discord name: invalid characters become "_", taken names get a number. */
async function freeUsername(db, discordName, now) {
  let base = discordName
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} _.-]/gu, '_')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .slice(0, 20);
  try {
    base = validUsername(base.length >= 3 ? base : `${base}player`.slice(0, 20));
  } catch {
    base = 'Commander';
  }
  for (let i = 0; i < 25; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 19)}${randomInt(10000)}`;
    try {
      validUsername(candidate);
    } catch {
      continue;
    }
    if (!(await userByUsername(db, candidate, now))) return candidate;
  }
  return `Commander${randomInt(1_000_000)}`;
}

/**
 * A Discord-verified address equal to the account's unverified one verifies
 * it (and claims its key). When another account verified that address first,
 * nothing changes.
 */
async function verifyByDiscord(ctx, user, verifiedEmail, eff) {
  if (!verifiedEmail || !user.email || user.email_verified === 1 || emailKey(verifiedEmail) !== emailKey(user.email)) return;
  try {
    await ctx.db
      .prepare('UPDATE users SET email_verified = 1, email_key = ?2, status = ?3 WHERE id = ?1')
      .bind(user.id, emailKey(user.email), statusAfterVerification(user, eff))
      .run();
  } catch (err) {
    if (uniqueViolation(err) !== 'email') throw err;
  }
}

async function callback(ctx) {
  const url = ctx.url;
  const outcome = (returnTo, code = null) => {
    ctx.cookies.push(cookieHeader(ctx.request, OAUTH_COOKIE, '', 0));
    const target = `${ctx.origin}${returnTo}#${code ? `discord=error&code=${code}` : 'discord=ok'}`;
    return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  };
  const state = url.searchParams.get('state') ?? '';
  const binding = parseCookies(ctx.request).get(cookieName(ctx.request, OAUTH_COOKIE)) ?? '';
  if (!STATE_RE.test(state)) return outcome(DEFAULT_RETURN, 'invalid_state');
  const row = await ctx.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?1 RETURNING *').bind(await sha256Hex(state)).first();
  if (!row || row.expires_at <= ctx.now || !STATE_RE.test(binding) || (await sha256Hex(binding)) !== row.binding_hash) {
    return outcome(row?.return_to ?? DEFAULT_RETURN, 'invalid_state');
  }
  const back = (code) => outcome(row.return_to, code);
  if (url.searchParams.get('error')) return back('denied');
  if (await ctx.ipBan()) return back('ip_banned');
  const eff = await ctx.eff();
  if (!eff.services.discord) return back('unavailable');
  if (!eff.login.discord) return back('method_disabled');
  const code = url.searchParams.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) return back('invalid_state');
  let discord;
  try {
    discord = await fetchDiscordUser(ctx.env, ctx.origin, code, row.verifier);
  } catch (err) {
    if (err instanceof DiscordError) {
      logError('discord oauth failed', err);
      return back('unavailable');
    }
    throw err;
  }
  let verifiedEmail = null;
  if (discord.emailVerified) {
    try {
      verifiedEmail = validEmail(discord.email);
    } catch {
      verifiedEmail = null;
    }
  }

  if (row.mode === 'link' || row.mode === 'reauth') {
    const { session, user } = await ctx.auth();
    if (!user || user.id !== row.user_id || !session || session.id_hash !== row.session_hash) return back('invalid_state');
    if (banOf(user)) return back('banned');
    if (row.mode === 'reauth') {
      if (user.discord_id !== discord.id) return back('invalid_state');
      await rotate(ctx, { reauth: true });
      return back(null);
    }
    if (!hasRecentReauth(session, ctx.now)) return back('invalid_state');
    const owner = await userByDiscord(ctx.db, discord.id, ctx.now);
    if (owner && owner.id !== user.id) return back('already_linked');
    try {
      await ctx.db
        .prepare('UPDATE users SET discord_id = ?2, discord_username = ?3, discord_linked_at = ?4 WHERE id = ?1')
        .bind(user.id, discord.id, discord.username, ctx.now)
        .run();
    } catch (err) {
      if (uniqueViolation(err) === 'discord') return back('already_linked');
      throw err;
    }
    await verifyByDiscord(ctx, user, verifiedEmail, eff);
    await rotate(ctx);
    return back(null);
  }

  // login and signup
  let user = await userByDiscord(ctx.db, discord.id, ctx.now);
  if (user) {
    if (user.status === 'deleted') return back('account_inactive');
    if (banOf(user)) return back('banned');
    await verifyByDiscord(ctx, user, verifiedEmail, eff);
    await ctx.db.prepare('UPDATE users SET discord_username = ?2 WHERE id = ?1').bind(user.id, discord.username).run();
  } else {
    if (row.mode !== 'signup') return back('no_account');
    if (!eff.registrationOpen) return back('registration_closed');
    // Every new account has an address: Discord's verified one, else the one typed on the signup form.
    const email = verifiedEmail ?? row.email;
    if (!email) return back('email_required');
    if (!(await ctx.limitSoft('signup', ctx.ip, ...LIMITS.signup))) return back('rate_limited');
    // Discord proved this address, so only its owner learns that it has an account.
    if (verifiedEmail && (await userByEmail(ctx.db, verifiedEmail, ctx.now))) return back('email_taken');
    const username = await freeUsername(ctx.db, discord.username, ctx.now);
    const status = initialStatus({ emailVerified: verifiedEmail !== null, eff });
    const { id, statement } = insertUser(
      ctx.db,
      { username, email, emailVerified: verifiedEmail !== null, status, discord: { id: discord.id, username: discord.username } },
      ctx.now,
    );
    try {
      await statement.run();
    } catch (err) {
      const which = uniqueViolation(err);
      if (which === 'email') return back('email_taken');
      if (which === 'discord') return back('already_linked');
      throw err;
    }
    // A typed address is confirmed like any other signup's (the answer does not wait for the mail).
    if (!verifiedEmail && eff.login.email) queueAddressMail(ctx, { userId: id, username, email, purpose: 'verify' });
    user = await userById(ctx.db, id, ctx.now);
  }
  const s = await createSession(ctx.env, ctx.request, ctx.ip, user.id, ctx.now);
  ctx.cookies.push(s.cookie);
  return back(null);
}

export function registerDiscordRoutes(router) {
  router.add('POST', '/api/auth/discord/start', start).add('GET', '/api/auth/discord/callback', callback, { navigation: true });
}

