// Validation of HTTP request bodies (pure, testable).

import { MAX_PLAYERS, MIN_PLAYERS, ProtocolError, validPassword, validSessionName, VERSION_RE } from '@webra/protocol';
import { HttpError } from './http.js';

const CREATE_KEYS = ['name', 'password', 'public', 'maxPlayers', 'version'];

/**
 * POST /api/sessions body: `{ name, password?, public, maxPlayers, version }`.
 * Returns the clean input for Session.init or throws HttpError(400).
 */
export function validateCreateSession(body) {
  const bad = (message) => new HttpError(400, 'invalid', message);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object.');
  for (const k of Object.keys(body)) if (!CREATE_KEYS.includes(k)) throw bad('Unknown field in request.');
  try {
    const name = validSessionName(body.name, 'name');
    let password = null;
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      password = validPassword(body.password, 'password');
    }
    if (typeof body.public !== 'boolean') throw bad('public must be true or false.');
    const maxPlayers = body.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
      throw bad(`maxPlayers must be ${MIN_PLAYERS} to ${MAX_PLAYERS}.`);
    }
    if (typeof body.version !== 'string' || !VERSION_RE.test(body.version)) throw bad('version is malformed.');
    return { name, password, isPublic: body.public, maxPlayers, version: body.version };
  } catch (err) {
    if (err instanceof ProtocolError) throw bad(`${err.message}.`);
    throw err;
  }
}
