// The realtime channel (docs/accounts-api.md 5.12): one WebSocket per page
// to the account's hub (GET /api/account/realtime) or to the admin topic
// (GET /api/admin/realtime). The server sends hints, never data: an event
// names a topic and what happened, and the page loads the document of that
// topic again (the same request it polls). The client sends nothing but
// `{"t":"ping"}`, which the hub answers with `{"t":"pong"}` without waking.
//
// parseRealtimeMessage takes raw text and validates it strictly (unknown
// types, topics or kinds, another version, a wrong shape or too many bytes
// are refused); fields it does not know are dropped, so the server can add
// some without a new version. encodeRealtimeEvent and encodeRealtimeHello
// validate before serializing.

import { ACCOUNT_STATUSES, USERNAME_MAX } from './accounts.js';

export const REALTIME_VERSION = 1;
export const REALTIME_TOPICS = Object.freeze(['friends', 'account', 'settings', 'replays', 'admin']);
export const REALTIME_KINDS = Object.freeze({
  friends: Object.freeze(['request', 'accept', 'ignore', 'withdraw', 'remove', 'block', 'unblock', 'invite', 'invite_dismiss', 'presence']),
  account: Object.freeze(['status', 'profile', 'signed_out']),
  settings: Object.freeze(['updated']),
  replays: Object.freeze(['added', 'removed']),
  admin: Object.freeze(['user_created', 'user_updated', 'user_approved', 'user_rejected', 'user_banned', 'user_unbanned', 'user_deleted', 'user_restored', 'user_purged']),
});
/** Close codes of the hub: the sign-in session ended (signed out, revoked, banned), or the socket is not allowed. */
export const REALTIME_CLOSE = Object.freeze({ SIGNED_OUT: 4001, FORBIDDEN: 4003 });
/** The client's keepalive (answered by the hub without waking it). */
export const REALTIME_PING_MS = 30_000;
/** Reconnect backoff: from 1 s, doubling, with full jitter, at most this long. */
export const REALTIME_BACKOFF_MIN_MS = 1_000;
export const REALTIME_BACKOFF_MAX_MS = 60_000;
/**
 * A channel counts as live while its hello or a hint arrived within this
 * time: only then do screens use their slow safety poll (a socket kept open
 * after the site setting was switched off hears nothing, so its pages go
 * back to the normal poll within this time).
 */
export const REALTIME_FRESH_MS = 10 * 60_000;
/** Events of one topic within this time cost one reload. */
export const REALTIME_REFETCH_DEBOUNCE_MS = 300;
/** The largest message either side sends. */
export const REALTIME_MAX_BYTES = 1024;
/** The keepalive, exactly as the client sends it and the hub's auto response matches it. */
export const REALTIME_PING = '{"t":"ping"}';
export const REALTIME_PONG = '{"t":"pong"}';

const USER_ID_RE = /^[0-9a-f]{32}$/;
const SESSION_RE = /^[0-9a-f]{64}$/;
const REPLAY_RE = /^[0-9a-f]{16}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * The `data` of an event, per topic: only what lets a page say who did it
 * (a username, public already) or skip a reload it does not need. Returns a
 * fresh object, or undefined when a field is malformed.
 */
const DATA = {
  friends: { username: (v) => typeof v === 'string' && v.length >= 1 && v.length <= USERNAME_MAX * 4, session: (v) => typeof v === 'string' && SESSION_RE.test(v) },
  account: { status: (v) => ACCOUNT_STATUSES.includes(v) },
  settings: { version: count },
  replays: { id: (v) => typeof v === 'string' && REPLAY_RE.test(v) },
  admin: { userId: (v) => typeof v === 'string' && USER_ID_RE.test(v) },
};

function cleanData(topic, data) {
  if (data === null || data === undefined) return null;
  if (!isObject(data)) return undefined;
  const spec = DATA[topic];
  const out = {};
  for (const [k, ok] of Object.entries(spec)) {
    if (!Object.hasOwn(data, k) || data[k] === undefined) continue;
    if (!ok(data[k])) return undefined;
    out[k] = data[k];
  }
  return Object.keys(out).length ? out : null;
}

/** A validated event `{ t, v, seq, topic, kind, at, data }`, or null. */
function cleanEvent(m) {
  if (!REALTIME_TOPICS.includes(m.topic) || !REALTIME_KINDS[m.topic].includes(m.kind)) return null;
  if (!count(m.seq) || m.seq < 1 || !count(m.at)) return null;
  const data = cleanData(m.topic, m.data);
  if (data === undefined) return null;
  return { t: 'event', v: REALTIME_VERSION, seq: m.seq, topic: m.topic, kind: m.kind, at: m.at, data };
}

function cleanHello(m) {
  if (!count(m.seq) || !Array.isArray(m.topics) || m.topics.length > REALTIME_TOPICS.length) return null;
  if (!m.topics.every((t) => REALTIME_TOPICS.includes(t)) || new Set(m.topics).size !== m.topics.length) return null;
  if (m.userId !== null && !(typeof m.userId === 'string' && USER_ID_RE.test(m.userId))) return null;
  return { t: 'hello', v: REALTIME_VERSION, seq: m.seq, topics: [...m.topics], userId: m.userId };
}

/**
 * A message from the hub: `{ ok: true, msg }` with a fresh, validated
 * object (`hello`, `event` or `pong`), or `{ ok: false, error }`.
 */
export function parseRealtimeMessage(text) {
  if (typeof text !== 'string') return { ok: false, error: 'not text' };
  if (text.length > REALTIME_MAX_BYTES) return { ok: false, error: 'too large' };
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (!isObject(m)) return { ok: false, error: 'not an object' };
  if (m.t === 'pong') return { ok: true, msg: { t: 'pong' } };
  if (m.t !== 'hello' && m.t !== 'event') return { ok: false, error: 'unknown type' };
  if (m.v !== REALTIME_VERSION) return { ok: false, error: 'unknown version' };
  const msg = m.t === 'hello' ? cleanHello(m) : cleanEvent(m);
  return msg ? { ok: true, msg } : { ok: false, error: `malformed ${m.t}` };
}

function encode(msg) {
  const text = JSON.stringify(msg);
  if (text.length > REALTIME_MAX_BYTES) throw new TypeError('realtime message too large');
  return text;
}

/** The text of an event (`{ seq, topic, kind, at, data }`); throws TypeError when it is not valid. */
export function encodeRealtimeEvent(event) {
  const msg = isObject(event) ? cleanEvent({ ...event, data: event.data ?? null }) : null;
  if (!msg) throw new TypeError('invalid realtime event');
  return encode(msg);
}

/** The text of the hub's greeting (`{ seq, topics, userId }`); throws TypeError when it is not valid. */
export function encodeRealtimeHello(hello) {
  const msg = isObject(hello) ? cleanHello({ ...hello, userId: hello.userId ?? null }) : null;
  if (!msg) throw new TypeError('invalid realtime hello');
  return encode(msg);
}
