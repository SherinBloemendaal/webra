// Per-account settings documents with optimistic concurrency
// (docs/accounts-api.md, section 5.8): a version number exposed as the ETag
// `"v<version>"`; writes need a matching If-Match.

import { validateSettingsDocument } from '@webra/protocol';
import { HttpError, json, readJson } from '../http.js';
import { check, invalid, isPlainObjectValue } from './context.js';

export const SETTINGS_BODY_MAX = 40 * 1024;

export async function getSettingsDoc(db, userId) {
  const row = await db.prepare('SELECT version, doc, updated_at FROM settings_docs WHERE user_id = ?1').bind(userId).first();
  if (!row) return { version: 0, updatedAt: null, settings: {} };
  let settings = {};
  try {
    settings = JSON.parse(row.doc);
  } catch {
    settings = {};
  }
  return { version: row.version, updatedAt: row.updated_at, settings };
}

export const etag = (version) => `"v${version}"`;

export function settingsResponse(doc, status = 200) {
  return json(doc, status, { etag: etag(doc.version) });
}

/** The version an If-Match header names; 428 without one, 400 when malformed. */
export function ifMatchVersion(request) {
  const header = request.headers.get('If-Match');
  if (header === null) throw new HttpError(428, 'precondition_required', 'Send If-Match with the version you are replacing.');
  const m = /^(?:W\/)?"v(0|[1-9][0-9]{0,9})"$/.exec(header.trim());
  if (!m) throw invalid('If-Match', 'If-Match must look like "v3".');
  return Number(m[1]);
}

/** Read and validate `{ settings }` from the request body. */
export async function readSettingsBody(request) {
  const { value } = await readJson(request, SETTINGS_BODY_MAX);
  if (!isPlainObjectValue(value)) throw invalid(null, 'Body must be a JSON object.');
  for (const k of Object.keys(value)) if (k !== 'settings') throw invalid(k, 'Unknown field.');
  return check(() => validateSettingsDocument(value.settings, 'settings'), 'settings');
}

/**
 * Replace the document when its stored version is `expected`. Returns the
 * new document, or throws 412 with the current one.
 */
export async function putSettingsDoc(db, userId, expected, settings, actorId, now = Date.now()) {
  const doc = JSON.stringify(settings);
  let changes;
  if (expected === 0) {
    const r = await db
      .prepare('INSERT INTO settings_docs (user_id, version, doc, updated_at, updated_by) VALUES (?1, 1, ?2, ?3, ?4) ON CONFLICT(user_id) DO NOTHING')
      .bind(userId, doc, now, actorId)
      .run();
    changes = r.meta.changes;
  } else {
    const r = await db
      .prepare('UPDATE settings_docs SET version = version + 1, doc = ?2, updated_at = ?3, updated_by = ?4 WHERE user_id = ?1 AND version = ?5')
      .bind(userId, doc, now, actorId, expected)
      .run();
    changes = r.meta.changes;
  }
  if (changes !== 1) {
    const current = await getSettingsDoc(db, userId);
    throw new HttpError(412, 'version_conflict', 'The settings changed on another device. Merge and try again.', { etag: etag(current.version) }, {
      current: { version: current.version, settings: current.settings },
    });
  }
  return { version: expected + 1, updatedAt: now, settings };
}
