// Passkey storage: challenges (single use, 5 minutes), credential rows and
// the option objects handed to navigator.credentials (docs/accounts-api.md 4.4).

import { HttpError } from '../http.js';
import { randomHex, randomToken } from '../crypto.js';
import { ALG_EDDSA, ALG_ES256, ALG_RS256, CHALLENGE_TTL_MS } from './webauthn.js';

export const PASSKEYS_MAX = 20;
const CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;

export async function createChallenge(db, purpose, { userId = null, data = null } = {}, now = Date.now()) {
  const id = randomHex(16);
  const challenge = randomToken();
  await db
    .prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, data, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, challenge, purpose, userId, data === null ? null : JSON.stringify(data), now + CHALLENGE_TTL_MS)
    .run();
  return { id, challenge };
}

/**
 * Use a challenge (deleted whatever happens next). Returns { challenge, data }
 * when it exists, has `purpose`, belongs to `userId` (when given) and has not
 * expired; otherwise null.
 */
export async function consumeChallenge(db, id, purpose, { userId = null } = {}, now = Date.now()) {
  if (typeof id !== 'string' || !CHALLENGE_ID_RE.test(id)) return null;
  const row = await db.prepare('DELETE FROM webauthn_challenges WHERE id = ?1 RETURNING *').bind(id).first();
  if (!row || row.purpose !== purpose || row.expires_at <= now) return null;
  if (userId !== null && row.user_id !== userId) return null;
  let data = null;
  try {
    data = row.data ? JSON.parse(row.data) : null;
  } catch {
    return null;
  }
  return { challenge: row.challenge, data };
}

export const PUB_KEY_PARAMS = [ALG_EDDSA, ALG_ES256, ALG_RS256].map((alg) => ({ type: 'public-key', alg }));

export function creationOptions({ rpId, challenge, userHandle, username, displayName, exclude = [] }) {
  return {
    rp: { id: rpId, name: 'WebRA' },
    user: { id: userHandle, name: username, displayName },
    challenge,
    pubKeyCredParams: PUB_KEY_PARAMS,
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
    excludeCredentials: exclude.map((p) => ({ type: 'public-key', id: p.id, transports: parseTransports(p.transports) })),
  };
}

export function requestOptions({ rpId, challenge, allow = [] }) {
  return {
    challenge,
    rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'preferred',
    allowCredentials: allow.map((p) => ({ type: 'public-key', id: p.id, transports: parseTransports(p.transports) })),
  };
}

function parseTransports(textValue) {
  try {
    const v = JSON.parse(textValue ?? '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export async function listPasskeys(db, userId) {
  const { results } = await db.prepare('SELECT * FROM passkeys WHERE user_id = ?1 ORDER BY created_at').bind(userId).all();
  return results;
}

export function passkeyView(row) {
  return {
    id: row.id,
    name: row.name,
    alg: row.alg,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    backedUp: row.backed_up === 1,
    transports: parseTransports(row.transports),
    counterError: row.counter_error === 1,
  };
}

/** INSERT statement for a verified registration. */
export function insertPasskey(db, userId, name, reg, now = Date.now()) {
  return db
    .prepare(
      `INSERT INTO passkeys (id, user_id, name, public_key, alg, sign_count, transports, backed_up, uv, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(reg.credentialId, userId, name, reg.publicKey, reg.alg, reg.signCount, JSON.stringify(reg.transports), reg.backedUp ? 1 : 0, reg.uv ? 1 : 0, now);
}

export function duplicatePasskey(err) {
  return /UNIQUE constraint failed: passkeys\.id/.test(String(err?.message ?? ''));
}

export const passkeyConflict = () => new HttpError(409, 'conflict', 'This passkey is already registered.', {}, { field: 'credential' });
