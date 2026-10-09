// Site settings (docs/accounts-api.md, section 2.5): one versioned document
// in D1, edited by admins, read on every request that depends on it. The
// services behind login methods (email sending, Discord) are detected from
// the environment.

import {
  DEFAULT_SITE_SETTINGS,
  DISPLAY_NAME_MAX,
  normalizeSiteSettings,
  ACCOUNT_PASSWORD_MAX,
  ACCOUNT_PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
} from '@webra/protocol';
import { rpIdFor } from './webauthn.js';

/** Which configured services exist (independent of the settings). */
export function services(env) {
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  return {
    email: Boolean(env?.EMAIL) && typeof env.EMAIL.send === 'function',
    discord: nonEmpty(env?.DISCORD_CLIENT_ID) && nonEmpty(env?.DISCORD_CLIENT_SECRET),
  };
}

/** The stored settings, or the defaults (version 0) when none are stored. */
export async function loadSite(db) {
  const row = await db.prepare('SELECT version, doc, updated_at FROM site_settings WHERE id = 1').first();
  if (!row) return { version: 0, settings: structuredClone(DEFAULT_SITE_SETTINGS), updatedAt: null };
  let doc = null;
  try {
    doc = JSON.parse(row.doc);
  } catch {
    // A corrupt row reads as the defaults; the next admin save replaces it.
  }
  return { version: row.version, settings: normalizeSiteSettings(doc), updatedAt: row.updated_at };
}

/**
 * Store new settings if the stored version is still `expected`. Returns the
 * new version, or null when someone else saved meanwhile.
 */
export async function saveSite(db, settings, expected, actorId, now = Date.now()) {
  const doc = JSON.stringify(settings);
  if (expected === 0) {
    const r = await db
      .prepare('INSERT INTO site_settings (id, version, doc, updated_at, updated_by) VALUES (1, 1, ?1, ?2, ?3) ON CONFLICT(id) DO NOTHING')
      .bind(doc, now, actorId)
      .run();
    return r.meta.changes === 1 ? 1 : null;
  }
  const r = await db
    .prepare('UPDATE site_settings SET version = version + 1, doc = ?1, updated_at = ?2, updated_by = ?3 WHERE id = 1 AND version = ?4')
    .bind(doc, now, actorId, expected)
    .run();
  return r.meta.changes === 1 ? expected + 1 : null;
}

/**
 * Effective switches: a login method counts only when it is on and its
 * service is configured; email verification only while email works.
 */
export function effective(settings, env) {
  const svc = services(env);
  const login = {
    password: settings.login.password,
    email: settings.login.email && svc.email,
    discord: settings.login.discord && svc.discord,
    passkey: settings.login.passkey,
  };
  return {
    login,
    services: svc,
    emailVerificationRequired: settings.registration.emailVerification && login.email,
    approvalRequired: settings.registration.approvalRequired,
    registrationOpen: settings.registration.open,
    onlineRequiresAccount: settings.onlineRequiresAccount,
    contentRelay: settings.contentRelay,
  };
}

/** Body of GET /api/site. */
export function publicSite(request, env, settings) {
  const eff = effective(settings, env);
  return {
    registration: {
      open: settings.registration.open,
      approvalRequired: settings.registration.approvalRequired,
      emailVerificationRequired: eff.emailVerificationRequired,
    },
    login: eff.login,
    services: eff.services,
    onlineRequiresAccount: settings.onlineRequiresAccount,
    contentRelay: settings.contentRelay,
    motd: settings.motd,
    passkey: { rpId: rpIdFor(request) },
    policy: {
      usernameMin: USERNAME_MIN,
      usernameMax: USERNAME_MAX,
      passwordMin: ACCOUNT_PASSWORD_MIN,
      passwordMax: ACCOUNT_PASSWORD_MAX,
      displayNameMax: DISPLAY_NAME_MAX,
    },
    privacyUrl: '/privacy.html',
  };
}
