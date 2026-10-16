// The realtime hub (docs/accounts-api.md 5.12, docs/security.md "Realtime
// channel"): a Durable Object with hibernating WebSockets. One object per
// account (`user:<id>`: every tab and device of that account) and one for
// the admin dashboard (`topic:admin`). The Worker authenticates the upgrade
// and tells the object who it is in X-WebRA-Auth; routes publish hints after
// their D1 writes (src/realtime/publish.js) and close the sockets of ended
// sign-in sessions.
//
// Hibernation rules: no timers, no state in memory that matters. Each
// socket's attachment holds what its handlers need, the storage holds only
// `seq` (the number of the last event), and the keepalive ping is answered
// by the runtime without waking the object.

import { DurableObject } from 'cloudflare:workers';
import { ACCOUNT_ROLES, encodeRealtimeEvent, encodeRealtimeHello, REALTIME_CLOSE, REALTIME_MAX_BYTES, REALTIME_PING, REALTIME_PONG, REALTIME_TOPICS } from '@webra/protocol';
import { AUTH_HEADER } from './accounts/play.js';

/** Sockets per object (tabs and devices of one account, or admins on the dashboard). */
export const MAX_SOCKETS = 16;
/** Client messages per socket and minute that reach the object (the auto-answered ping is not one). */
export const MESSAGE_LIMIT = 10;
const MINUTE = 60_000;
/** Topics where the device that made the change is skipped (it has the new document already). */
const ORIGIN_SKIP = new Set(['settings', 'replays', 'admin']);
const USER_ID_RE = /^[0-9a-f]{32}$/;
const SID_RE = /^[0-9a-f]{16}$/;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_LARGE = 1009;

/**
 * The Worker's verdict from the upgrade request: `{ userId, username, sid,
 * role, status, topics }`, or null when it is missing or malformed.
 */
export function readHubAuth(request) {
  const raw = request.headers.get(AUTH_HEADER);
  if (raw === null) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!USER_ID_RE.test(v.userId ?? '') || !SID_RE.test(v.sid ?? '') || typeof v.username !== 'string' || typeof v.status !== 'string') return null;
  if (!ACCOUNT_ROLES.includes(v.role)) return null;
  if (!Array.isArray(v.topics) || v.topics.length === 0 || !v.topics.every((t) => REALTIME_TOPICS.includes(t)) || new Set(v.topics).size !== v.topics.length) return null;
  return { userId: v.userId, username: v.username, sid: v.sid, role: v.role, status: v.status, topics: [...v.topics] };
}

export class UserHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The client's keepalive is answered by the runtime: a hibernated object stays asleep.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(REALTIME_PING, REALTIME_PONG));
  }

  /** The 101 answer that hands the client side of the pair to the runtime. */
  upgraded(client) {
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade.', { status: 426 });
    const auth = readHubAuth(request);
    if (!auth) return new Response('Could not check your account.', { status: 403 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Too many connections.', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    // Tags: a sign-in session's sockets, an account's sockets (on the admin object) and each topic.
    this.ctx.acceptWebSocket(server, [`sid:${auth.sid}`, `user:${auth.userId}`, ...auth.topics.map((t) => `topic:${t}`)]);
    server.serializeAttachment({ userId: auth.userId, sid: auth.sid, role: auth.role, topics: auth.topics, since: Date.now(), window: 0, messages: 0 });
    const seq = (await this.ctx.storage.get('seq')) ?? 0;
    server.send(encodeRealtimeHello({ seq, topics: auth.topics, userId: auth.userId }));
    return this.upgraded(client);
  }

  /**
   * The client sends nothing but the ping, which never gets here. Anything
   * else is counted against MESSAGE_LIMIT per minute (kept in the socket's
   * attachment) and otherwise ignored, so newer clients can send more.
   */
  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() ?? {};
    const now = Date.now();
    const window = Math.floor(now / MINUTE);
    const messages = att.window === window ? (att.messages ?? 0) + 1 : 1;
    ws.serializeAttachment({ ...att, window, messages });
    if (messages > MESSAGE_LIMIT) return this.close(ws, CLOSE_POLICY, 'rate_limited');
    const size = typeof message === 'string' ? message.length : (message?.byteLength ?? 0);
    if (size > REALTIME_MAX_BYTES) return this.close(ws, CLOSE_TOO_LARGE, 'too_large');
    // A ping spelled differently than the auto response expects still gets its answer.
    if (typeof message === 'string' && /^\s*\{\s*"t"\s*:\s*"ping"\s*\}\s*$/.test(message)) this.sendRaw(ws, REALTIME_PONG);
  }

  /** Nothing to clean up: the attachment ends with the socket. */
  async webSocketClose() {}

  async webSocketError() {}

  /**
   * RPC: one event to every socket that follows `topic`. The sign-in session
   * `origin` (the device that made the change) is skipped for topics whose
   * pages reload after their own changes anyway. Returns how many sockets
   * it reached. Without listeners nothing is stored (no write per offline
   * account).
   */
  async publish({ topic, kind, data = null, origin = null }) {
    if (!REALTIME_TOPICS.includes(topic)) throw new TypeError('unknown realtime topic');
    const skip = ORIGIN_SKIP.has(topic) && typeof origin === 'string' ? origin : null;
    const targets = this.ctx.getWebSockets(`topic:${topic}`).filter((ws) => skip === null || ws.deserializeAttachment()?.sid !== skip);
    if (targets.length === 0) return 0;
    const seq = ((await this.ctx.storage.get('seq')) ?? 0) + 1;
    await this.ctx.storage.put('seq', seq);
    const text = encodeRealtimeEvent({ seq, topic, kind, at: Date.now(), data });
    let reached = 0;
    for (const ws of targets) if (this.sendRaw(ws, text)) reached++;
    return reached;
  }

  /**
   * RPC: close the sockets of ended sign-in sessions with 4001 `signed_out`
   * (the page asks who is signed in and finds out). `sids`: those sessions,
   * or null for all; `except`: a session that stays (the one that changed
   * the password); `userId`: only that account's sockets (on the admin
   * object, which several accounts share). Returns how many it closed.
   */
  async closeSessions({ sids = null, except = null, userId = null } = {}) {
    if (sids !== null && (!Array.isArray(sids) || !sids.every((s) => typeof s === 'string' && SID_RE.test(s)))) throw new TypeError('sids must be session ids or null');
    const pool = userId === null ? this.ctx.getWebSockets() : USER_ID_RE.test(userId) ? this.ctx.getWebSockets(`user:${userId}`) : [];
    const wanted = sids === null ? null : new Set(sids);
    let closed = 0;
    for (const ws of pool) {
      const sid = ws.deserializeAttachment()?.sid ?? null;
      if (sid !== null && sid === except) continue;
      if (wanted !== null && !wanted.has(sid)) continue;
      this.close(ws, REALTIME_CLOSE.SIGNED_OUT, 'signed_out');
      closed++;
    }
    return closed;
  }

  /** RPC: open sockets (tests and diagnostics). */
  async count() {
    return this.ctx.getWebSockets().length;
  }

  sendRaw(ws, text) {
    try {
      ws.send(text);
      return true;
    } catch {
      // Closed meanwhile: the runtime drops it.
      return false;
    }
  }

  close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
