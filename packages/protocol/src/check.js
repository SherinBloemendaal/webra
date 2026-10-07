// Small strict validation helpers. Every helper either returns a clean value
// or throws a ProtocolError; callers never see half-validated input.

export class ProtocolError extends Error {
  /**
   * @param {string} message human readable, never contains raw input beyond a short excerpt
   * @param {string} [code] machine readable error code
   */
  constructor(message, code = 'bad_message') {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function fail(message, code) {
  throw new ProtocolError(message, code);
}

/** A short, printable excerpt of untrusted text for error messages. */
export function excerpt(value, max = 32) {
  const s = Array.from(String(value)).slice(0, max).join('');
  return s.replace(/[^\x20-\x7e]/g, '?');
}

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Throws unless `obj` is a plain object whose keys are all in `allowed`. */
export function object(obj, allowed, what) {
  if (!isPlainObject(obj)) fail(`${what} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${what}: unknown field ${excerpt(k)}`);
  }
  return obj;
}

export function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

export function int(v, min, max, what) {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${what} must be an integer from ${min} to ${max}`);
  return v;
}

export function bool(v, what) {
  if (typeof v !== 'boolean') fail(`${what} must be true or false`);
  return v;
}

export function oneOf(v, allowed, what) {
  if (!allowed.includes(v)) fail(`${what} has an unsupported value`);
  return v;
}

export function matches(v, re, what) {
  if (typeof v !== 'string' || !re.test(v)) fail(`${what} is malformed`);
  return v;
}

const isWellFormed =
  typeof String.prototype.isWellFormed === 'function'
    ? (s) => s.isWellFormed()
    : (s) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s);

// Control characters, bidi overrides/isolates and other invisible formatting
// that could spoof names or chat. Zero-width joiners stay (emoji sequences).
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

/**
 * Normalize untrusted display text: NFC, whitespace runs collapsed to one
 * space, trimmed. Rejects control and bidi characters and lone surrogates.
 * Length is counted in code points.
 */
export function text(v, min, max, what) {
  if (typeof v !== 'string') fail(`${what} must be text`);
  // Cheap guard before any heavier work on a huge string.
  if (v.length > max * 4 + 16) fail(`${what} is too long`);
  if (!isWellFormed(v)) fail(`${what} contains invalid characters`);
  const s = v.normalize('NFC').replace(/[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').trim();
  if (FORBIDDEN_CHARS.test(s)) fail(`${what} contains invalid characters`);
  const n = Array.from(s).length;
  if (n < min) fail(min === 1 ? `${what} must not be empty` : `${what} is too short`);
  if (n > max) fail(`${what} must be at most ${max} characters`);
  return s;
}

/**
 * Validate text without changing it (map fields are hashed byte for byte).
 * Rejects control and bidi characters except line breaks when `multiline`.
 */
export function rawText(v, min, max, what, multiline = false) {
  if (typeof v !== 'string') fail(`${what} must be text`);
  if (v.length > max * 4 + 16) fail(`${what} is too long`);
  if (!isWellFormed(v)) fail(`${what} contains invalid characters`);
  if (FORBIDDEN_CHARS.test(multiline ? v.replace(/\n/g, '') : v)) fail(`${what} contains invalid characters`);
  const n = Array.from(v).length;
  if (n < min || n > max) fail(`${what} must be ${min} to ${max} characters`);
  if (min > 0 && v.trim() === '') fail(`${what} must not be blank`);
  return v;
}

/** Truncate any string to `max` code points (for echoing untrusted text). */
export function truncate(v, max) {
  const s = String(v ?? '');
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

/** UTF-8 byte length without allocating when the string is plainly small or large. */
export function utf8Length(s) {
  if (s.length * 3 <= 0xffff && /^[\x00-\x7f]*$/.test(s)) return s.length;
  return new TextEncoder().encode(s).length;
}
