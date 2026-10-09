// Accounts: shared validators for usernames, emails, passwords, profile
// fields, the per-account settings document and the site settings
// (docs/accounts-api.md). The server is the authority; clients use the same
// functions to check input before sending it.
//
// Every validator returns a clean (normalized) value or throws a
// ProtocolError with code `invalid` and `field` naming the offending path.

import { COLOR_COUNT, FACTIONS, NAME_MAX, VERSION_RE } from './constants.js';
import { isPlainObject, ProtocolError, text } from './check.js';

// ---- Value sets ------------------------------------------------------------------

export const ACCOUNT_ROLES = Object.freeze(['user', 'moderator', 'admin']);
/** Stored statuses; `banned` is reported while an account ban is in effect. */
export const ACCOUNT_STORED_STATUSES = Object.freeze(['pending_email', 'pending_approval', 'active', 'deleted']);
export const ACCOUNT_STATUSES = Object.freeze(['pending_email', 'pending_approval', 'active', 'banned', 'deleted']);
/** Account flags and their bit in the stored mask. */
export const ACCOUNT_FLAGS = Object.freeze({ content_autoinstall: 1 });
export const ACCOUNT_FLAG_NAMES = Object.freeze(Object.keys(ACCOUNT_FLAGS));

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const DISPLAY_NAME_MAX = 32;
export const ACCOUNT_PASSWORD_MIN = 10;
export const ACCOUNT_PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;
export const DEVICE_LABEL_MAX = 40;
export const PASSKEY_NAME_MAX = 40;
export const BAN_REASON_MAX = 500;
export const MOTD_MAX = 500;

/** Error with the request field (a path such as `settings.audio.master`). */
export class FieldError extends ProtocolError {
  constructor(message, field) {
    super(message, 'invalid');
    this.field = field;
  }
}

function bad(field, message) {
  throw new FieldError(message, field);
}

/** Run a protocol text check and report failures against `field`. */
function wrapText(field, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FieldError) throw err;
    if (err instanceof ProtocolError) bad(field, `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`);
    throw err;
  }
}

// ---- Usernames ------------------------------------------------------------------

const USERNAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.-]*$/u;
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

/** Names nobody may register (compared after folding and without separators). */
export const RESERVED_USERNAMES = Object.freeze([
  'admin',
  'administrator',
  'moderator',
  'mod',
  'staff',
  'system',
  'root',
  'support',
  'webra',
  'server',
  'host',
  'spectator',
  'player',
  'anonymous',
  'guest',
  'null',
  'undefined',
  'nobody',
  'everyone',
  'openra',
  'ai',
]);

/**
 * A username as it will be stored and shown: lobby text rules (NFC, one space
 * between words, no control, bidi or invisible characters), 3 to 24
 * characters, letters, marks, digits, space, `_`, `-` and `.`, starting with
 * a letter or digit, no Latin mixed with Cyrillic or Greek.
 */
export function validUsername(v, field = 'username') {
  const s = wrapText(field, () => text(v, USERNAME_MIN, USERNAME_MAX, 'username'));
  if (!USERNAME_CHARS.test(s)) {
    bad(field, 'Username may only use letters, digits, spaces, "_", "-" and "." and must start with a letter or digit.');
  }
  const scripts = CONFUSABLE_SCRIPTS.filter((re) => re.test(s)).length;
  if (scripts > 1) bad(field, 'Username must not mix Latin, Cyrillic or Greek letters.');
  if (isReservedUsername(s)) bad(field, 'This username is reserved.');
  return s;
}

/** Uniqueness key: compatibility folded and lower cased. */
export function usernameKey(username) {
  return username.normalize('NFKC').toLowerCase().normalize('NFKC');
}

export function isReservedUsername(username) {
  const bare = usernameKey(username).replace(/[ _.-]/g, '');
  return RESERVED_USERNAMES.includes(bare);
}

// ---- Emails -----------------------------------------------------------------------

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** An email address: ASCII, local part as typed, domain lower cased. */
export function validEmail(v, field = 'email') {
  if (typeof v !== 'string') bad(field, 'Email must be text.');
  const s = v.trim();
  if (s.length < 3 || s.length > EMAIL_MAX) bad(field, `Email must be at most ${EMAIL_MAX} characters.`);
  const at = s.lastIndexOf('@');
  if (at <= 0 || s.indexOf('@') !== at) bad(field, 'Email address is malformed.');
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).toLowerCase();
  if (local.length > 64 || !EMAIL_LOCAL.test(local)) bad(field, 'Email address is malformed.');
  const labels = domain.split('.');
  if (labels.length < 2 || domain.length > 253 || !labels.every((l) => DOMAIN_LABEL.test(l)) || /^[0-9]+$/.test(labels.at(-1))) {
    bad(field, 'Email address is malformed.');
  }
  return `${local}@${domain}`;
}

/** Uniqueness key: the whole address lower cased. */
export function emailKey(email) {
  return email.toLowerCase();
}

/** `t***@example.com` for moderators. */
export function maskEmail(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

// ---- Passwords ------------------------------------------------------------------------

/** Very common passwords of policy length (lower case), refused at signup and change. */
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  '123456789012',
  '0987654321',
  '1111111111',
  '0000000000',
  'qwertyuiop',
  'qwertyuiop[]',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'password1234',
  'password123',
  'password12',
  'passw0rd123',
  'p@ssw0rd123',
  'iloveyou123',
  'abcdefghij',
  'abc1234567',
  'letmein123',
  'welcome123',
  'football123',
  'baseball123',
  'superman123',
  'starwars123',
  'sunshine123',
  'princess123',
  'dragon1234',
  'monkey1234',
  'trustno1234',
  'qwerty123456',
  'asdfghjkl1',
  'zxcvbnm123',
  'commander123',
  'redalert123',
]);

/** Password as typed at sign-in: any text up to the maximum, NFC. */
export function loginPassword(v, field = 'password') {
  if (typeof v !== 'string' || v.length < 1 || v.length > ACCOUNT_PASSWORD_MAX * 2) bad(field, 'Password is missing or too long.');
  return v.normalize('NFC');
}

/**
 * A new password: 10 to 128 code points after NFC, not the username or the
 * email, not a very common password.
 */
export function validNewPassword(v, { username = null, email = null } = {}, field = 'password') {
  if (typeof v !== 'string') bad(field, 'Password must be text.');
  if (v.length > ACCOUNT_PASSWORD_MAX * 2) bad(field, `Password must be at most ${ACCOUNT_PASSWORD_MAX} characters.`);
  const s = v.normalize('NFC');
  const n = Array.from(s).length;
  if (n < ACCOUNT_PASSWORD_MIN) bad(field, `Password must be at least ${ACCOUNT_PASSWORD_MIN} characters.`);
  if (n > ACCOUNT_PASSWORD_MAX) bad(field, `Password must be at most ${ACCOUNT_PASSWORD_MAX} characters.`);
  if (s.trim() === '') bad(field, 'Password must not be blank.');
  const lower = s.toLowerCase();
  if (username && lower === username.toLowerCase()) bad(field, 'Password must not be the username.');
  if (email && lower === email.toLowerCase()) bad(field, 'Password must not be the email address.');
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/u.test(s)) bad(field, 'This password is too common. Choose a longer or less predictable one.');
  return s;
}

// ---- Profile ------------------------------------------------------------------------------

export function validDisplayName(v, field = 'displayName') {
  return wrapText(field, () => text(v, 1, DISPLAY_NAME_MAX, 'display name'));
}

export function validAvatarColor(v, field = 'avatarColor') {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/.test(v)) bad(field, 'Avatar color must be #rrggbb in lower case hex.');
  return v;
}

export function validLabel(v, max, field) {
  return wrapText(field, () => text(v, 1, max, field));
}

export function validFlags(v, field = 'flags') {
  if (!Array.isArray(v) || v.length > 16) bad(field, 'Flags must be a list of known flags.');
  const out = [];
  for (const f of v) {
    if (!ACCOUNT_FLAG_NAMES.includes(f)) bad(field, 'Unknown flag.');
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export function flagsToMask(list) {
  return list.reduce((m, f) => m | ACCOUNT_FLAGS[f], 0);
}

export function maskToFlags(mask) {
  return ACCOUNT_FLAG_NAMES.filter((f) => (mask & ACCOUNT_FLAGS[f]) !== 0);
}

// ---- Settings document (docs/accounts-api.md, section 5.8) ----------------------------------

export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_MAX_BYTES = 32 * 1024;
export const SETTINGS_EXTRA_MAX_BYTES = 8 * 1024;
export const SETTINGS_LAST_OPTIONS_MAX_BYTES = 4 * 1024;
const HOTKEY_ACTIONS_MAX = 200;
const HOTKEY_COMBOS_MAX = 4;
const PACKS_MAX = 64;
const FREE_DEPTH_MAX = 4;
const FREE_STRING_MAX = 500;
const FREE_ARRAY_MAX = 64;
const FREE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Keys that would reach Object.prototype or a constructor when copied: never stored. */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HOTKEY_ACTION_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HOTKEY_COMBO_RE = /^[\x21-\x7e]{1,40}$/;

/**
 * Scale settings (game.uiScale, game.gameScale): "auto" or a factor in
 * these limits (1 = 100%). The game client's settings registry takes its
 * limits from here, so the client and the server always agree.
 */
export const UI_SCALE_LIMITS = Object.freeze({ min: 0.5, max: 2, step: 0.05 });
export const GAME_SCALE_LIMITS = Object.freeze({ min: 0.5, max: 3, step: 0.05 });
/** audio.musicRepeat: repeat the playlist, repeat one track, or stop after the last track. */
export const MUSIC_REPEAT_MODES = Object.freeze(['all', 'one', 'off']);

const num = (min, max) => (v, f) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(f, `Must be a number from ${min} to ${max}.`);
  return v;
};
const scale = ({ min, max }) => (v, f) => {
  if (v === 'auto') return v;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(f, `Must be "auto" or a number from ${min} to ${max}.`);
  return v;
};
const boolean = (v, f) => {
  if (typeof v !== 'boolean') bad(f, 'Must be true or false.');
  return v;
};
const choice = (options) => (v, f) => {
  if (!options.includes(v)) bad(f, `Must be one of ${options.join(', ')}.`);
  return v;
};

function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

/** Plain JSON data with bounded depth, key shapes and sizes (`extra`, `lastOptions`). */
function freeJson(v, f, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) bad(f, 'Numbers must be finite.');
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > FREE_STRING_MAX) bad(f, `Text must be at most ${FREE_STRING_MAX} characters.`);
    return v;
  }
  if (depth >= FREE_DEPTH_MAX) bad(f, `Nested at most ${FREE_DEPTH_MAX} levels.`);
  if (Array.isArray(v)) {
    if (v.length > FREE_ARRAY_MAX) bad(f, `Lists hold at most ${FREE_ARRAY_MAX} entries.`);
    return v.map((x, i) => freeJson(x, `${f}[${i}]`, depth + 1));
  }
  if (!isPlainObject(v)) bad(f, 'Must be JSON data.');
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!FREE_KEY_RE.test(k)) bad(f, 'Keys must be 1 to 64 letters, digits, "_", "." or "-".');
    if (PROTO_KEYS.has(k)) bad(`${f}.${k}`, 'This key is not allowed.');
    out[k] = freeJson(x, `${f}.${k}`, depth + 1);
  }
  return out;
}

function freeObject(maxBytes) {
  return (v, f) => {
    if (!isPlainObject(v)) bad(f, 'Must be an object.');
    const out = freeJson(v, f, 1);
    if (utf8Bytes(JSON.stringify(out)) > maxBytes) bad(f, `Must be at most ${maxBytes} bytes.`);
    return out;
  };
}

function hotkeys(v, f) {
  if (!isPlainObject(v)) bad(f, 'Must be an object.');
  const entries = Object.entries(v);
  if (entries.length > HOTKEY_ACTIONS_MAX) bad(f, `At most ${HOTKEY_ACTIONS_MAX} actions.`);
  const out = {};
  for (const [action, combos] of entries) {
    if (!HOTKEY_ACTION_RE.test(action)) bad(f, 'Action names are 1 to 64 letters, digits or "_.:-".');
    if (PROTO_KEYS.has(action)) bad(`${f}.${action}`, 'This action name is not allowed.');
    const p = `${f}.${action}`;
    if (!Array.isArray(combos) || combos.length > HOTKEY_COMBOS_MAX) bad(p, `Must be a list of at most ${HOTKEY_COMBOS_MAX} keys.`);
    out[action] = combos.map((c, i) => {
      if (typeof c !== 'string' || !HOTKEY_COMBO_RE.test(c)) bad(`${p}[${i}]`, 'Keys are 1 to 40 printable characters without spaces.');
      return c;
    });
  }
  return out;
}

function packs(v, f) {
  if (!Array.isArray(v) || v.length > PACKS_MAX) bad(f, `Must be a list of at most ${PACKS_MAX} packs.`);
  const seen = new Set();
  return v.map((p, i) => {
    const w = `${f}[${i}]`;
    section(p, ['id', 'enabled'], w);
    if (typeof p.id !== 'string' || p.id.length < 1 || p.id.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(p.id)) {
      bad(`${w}.id`, 'Pack ids are 1 to 160 characters without control characters.');
    }
    if (seen.has(p.id)) bad(`${w}.id`, 'A pack is listed twice.');
    seen.add(p.id);
    return { id: p.id, enabled: boolean(p.enabled, `${w}.enabled`) };
  });
}

function section(v, keys, f) {
  if (!isPlainObject(v)) bad(f, 'Must be an object.');
  for (const k of Object.keys(v)) if (PROTO_KEYS.has(k) || !keys.includes(k)) bad(`${f}.${k}`, 'Unknown setting.');
}

const SETTINGS_SECTIONS = {
  game: {
    edgeScrollSpeed: num(0, 3),
    keyScrollSpeed: num(0.25, 3),
    showUnitPaths: boolean,
    pixelRatioCap: num(0.5, 3),
    lowQuality: boolean,
    uiScale: scale(UI_SCALE_LIMITS),
    gameScale: scale(GAME_SCALE_LIMITS),
    healthBars: choice(['off', 'damaged', 'all']),
    graphics: choice(['webra', 'original']),
    hotkeys,
  },
  audio: {
    enabled: boolean,
    master: num(0, 1),
    effects: num(0, 1),
    voices: num(0, 1),
    music: num(0, 1),
    speech: boolean,
    original: boolean,
    musicOn: boolean,
    musicShuffle: boolean,
    musicRepeat: choice(MUSIC_REPEAT_MODES),
  },
  content: { packs },
  debug: Object.fromEntries(['cells', 'footprints', 'flow', 'combat', 'tags', 'health', 'stats', 'graph', 'cpuInstances'].map((k) => [k, boolean])),
  lobby: {
    name: (v, f) => wrapText(f, () => text(v, 1, Math.min(20, NAME_MAX), 'name')),
    faction: choice(FACTIONS),
    color: (v, f) => {
      if (!Number.isInteger(v) || v < 0 || v >= COLOR_COUNT) bad(f, `Must be an integer from 0 to ${COLOR_COUNT - 1}.`);
      return v;
    },
    lastOptions: freeObject(SETTINGS_LAST_OPTIONS_MAX_BYTES),
  },
  releaseNotes: {
    lastSeenVersion: (v, f) => {
      if (typeof v !== 'string' || !VERSION_RE.test(v)) bad(f, 'Must be a version.');
      return v;
    },
  },
};

/**
 * Validate a settings document (schema 1). Every section and key is
 * optional; unknown keys are refused except inside `extra`. Returns a clean
 * copy; throws FieldError with a path under `field`.
 */
export function validateSettingsDocument(doc, field = 'settings') {
  if (!isPlainObject(doc)) bad(field, 'Settings must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    const f = `${field}.${k}`;
    if (PROTO_KEYS.has(k)) bad(f, 'Unknown settings section.');
    if (k === 'schema') {
      if (v !== SETTINGS_SCHEMA_VERSION) bad(f, `Schema must be ${SETTINGS_SCHEMA_VERSION}.`);
      out.schema = v;
    } else if (k === 'extra') {
      out.extra = freeObject(SETTINGS_EXTRA_MAX_BYTES)(v, f);
    } else if (Object.hasOwn(SETTINGS_SECTIONS, k)) {
      const spec = SETTINGS_SECTIONS[k];
      section(v, Object.keys(spec), f);
      const clean = {};
      for (const [key, value] of Object.entries(v)) clean[key] = spec[key](value, `${f}.${key}`);
      out[k] = clean;
    } else {
      bad(f, 'Unknown settings section.');
    }
  }
  if (utf8Bytes(JSON.stringify(out)) > SETTINGS_MAX_BYTES) bad(field, `Settings must be at most ${SETTINGS_MAX_BYTES} bytes.`);
  return out;
}

// ---- Site settings (section 2.5) ------------------------------------------------------------

export const DEFAULT_SITE_SETTINGS = Object.freeze({
  registration: Object.freeze({ open: true, approvalRequired: true, emailVerification: true }),
  login: Object.freeze({ password: true, email: true, discord: true, passkey: true }),
  onlineRequiresAccount: true,
  contentRelay: true,
  motd: '',
});

const SITE_SHAPE = {
  registration: { open: boolean, approvalRequired: boolean, emailVerification: boolean },
  login: { password: boolean, email: boolean, discord: boolean, passkey: boolean },
  onlineRequiresAccount: boolean,
  contentRelay: boolean,
  motd: (v, f) => {
    if (typeof v !== 'string') bad(f, 'Must be text.');
    const s = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (Array.from(s).length > MOTD_MAX) bad(f, `Must be at most ${MOTD_MAX} characters.`);
    if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(s)) bad(f, 'Contains invalid characters.');
    return s;
  },
};

/**
 * Apply a partial update to site settings: nested objects merge, unknown
 * keys are refused. Returns the new settings (without `version`).
 */
export function mergeSiteSettings(current, patch, field = 'settings') {
  if (!isPlainObject(patch)) bad(field, 'Settings must be an object.');
  const out = structuredClone(current);
  for (const [k, v] of Object.entries(patch)) {
    const f = `${field}.${k}`;
    if (!Object.hasOwn(SITE_SHAPE, k)) bad(f, 'Unknown setting.');
    const spec = SITE_SHAPE[k];
    if (typeof spec === 'function') {
      out[k] = spec(v, f);
      continue;
    }
    section(v, Object.keys(spec), f);
    for (const [key, value] of Object.entries(v)) out[k][key] = spec[key](value, `${f}.${key}`);
  }
  return out;
}

/** Stored site settings over the defaults (keys the code no longer knows are dropped). */
export function normalizeSiteSettings(stored) {
  const out = structuredClone(DEFAULT_SITE_SETTINGS);
  if (!isPlainObject(stored)) return out;
  for (const [k, spec] of Object.entries(SITE_SHAPE)) {
    if (!Object.hasOwn(stored, k)) continue;
    try {
      if (typeof spec === 'function') out[k] = spec(stored[k], k);
      else if (isPlainObject(stored[k])) {
        for (const key of Object.keys(spec)) if (Object.hasOwn(stored[k], key)) out[k][key] = spec[key](stored[k][key], key);
      }
    } catch {
      // A bad stored value keeps its default.
    }
  }
  return out;
}
