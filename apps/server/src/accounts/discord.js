// Discord OAuth2 (authorization code with PKCE S256 and state). The client
// id is a wrangler var (DISCORD_CLIENT_ID), the secret a Worker secret
// (DISCORD_CLIENT_SECRET); without both, Discord sign-in is unavailable.

import { sha256Bytes, toBase64Url } from '../crypto.js';

export const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
export const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token';
export const DISCORD_REVOKE = 'https://discord.com/api/oauth2/token/revoke';
export const DISCORD_ME = 'https://discord.com/api/users/@me';
export const OAUTH_COOKIE = 'webra_oauth';
export const OAUTH_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** Replaceable for tests (they never reach discord.com). */
export const discordApi = { fetch: (...args) => fetch(...args) };

export class DiscordError extends Error {}

export function redirectUri(origin) {
  return `${origin}/api/auth/discord/callback`;
}

export async function pkceChallenge(verifier) {
  return toBase64Url(await sha256Bytes(verifier));
}

export function authorizeUrl(env, origin, state, challenge) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env.DISCORD_CLIENT_ID.trim(),
    scope: 'identify email',
    state,
    redirect_uri: redirectUri(origin),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${DISCORD_AUTHORIZE}?${q}`;
}

async function call(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await discordApi.fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch {
    throw new DiscordError('Discord is unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange the code and read the user. Returns { id, username, email,
 * emailVerified }. The access token is revoked afterwards (best effort).
 */
export async function fetchDiscordUser(env, origin, code, verifier) {
  const auth = {
    client_id: env.DISCORD_CLIENT_ID.trim(),
    client_secret: env.DISCORD_CLIENT_SECRET,
  };
  const tokenRes = await call(DISCORD_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...auth, grant_type: 'authorization_code', code, redirect_uri: redirectUri(origin), code_verifier: verifier }),
  });
  if (!tokenRes.ok) throw new DiscordError(`token exchange failed (${tokenRes.status})`);
  const token = await tokenRes.json().catch(() => null);
  if (!token || typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') throw new DiscordError('malformed token response');
  const scopes = String(token.scope ?? '').split(' ');
  try {
    const meRes = await call(DISCORD_ME, { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' } });
    if (!meRes.ok) throw new DiscordError(`user lookup failed (${meRes.status})`);
    const me = await meRes.json().catch(() => null);
    if (!me || typeof me.id !== 'string' || !/^[0-9]{1,24}$/.test(me.id) || typeof me.username !== 'string') throw new DiscordError('malformed user');
    const hasEmail = scopes.includes('email') && typeof me.email === 'string' && me.email.length > 0;
    return {
      id: me.id,
      username: me.username.slice(0, 64),
      email: hasEmail ? me.email : null,
      emailVerified: hasEmail && me.verified === true,
    };
  } finally {
    await call(DISCORD_REVOKE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...auth, token: token.access_token, token_type_hint: 'access_token' }),
    }).catch(() => {});
  }
}
