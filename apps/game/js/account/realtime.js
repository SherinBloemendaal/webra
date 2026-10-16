// The realtime channel (docs/accounts-api.md 5.12): one WebSocket per page to
// the account's hub (or, on the admin page, to the dashboard's), used by the
// game, the account page and the admin page. The server sends hints: a topic
// (friends, account, settings, replays, admin) and what happened. Every
// screen loads its document again on a hint, and on every (re)connect, so a
// missed hint costs nothing but time; the screens keep polling, slowly while
// the channel is open and as before while it is not.
//
//   const realtime = new RealtimeClient();
//   realtime.allow();                                   // signed in (AccountSession does this)
//   const off = realtime.subscribe('friends', (e) => store.refresh());
//   realtime.state;                                     // 'open' while hints arrive
//   off();
//
// No DOM besides the document's visibility. It imports only the protocol and
// the Emitter, so the website loads it from /lib/ too.

import {
  parseRealtimeMessage,
  REALTIME_BACKOFF_MAX_MS,
  REALTIME_BACKOFF_MIN_MS,
  REALTIME_CLOSE,
  REALTIME_PING,
  REALTIME_PING_MS,
  REALTIME_REFETCH_DEBOUNCE_MS,
} from '../protocol.js';
import { Emitter } from '../netquality.js';

/** After the last screen lets go, the socket stays this long (a screen switch does not reconnect). */
export const REALTIME_LINGER_MS = 5_000;
/** Connects that fail in a row (no hello) before the channel counts as unavailable. */
export const REALTIME_FAILURES_MAX = 3;
/** How long an unavailable channel is not tried again (the screens poll meanwhile). */
export const REALTIME_UNAVAILABLE_MS = 10 * 60_000;
/** A second sign-out close this soon after the first one: something is off, poll for a while instead. */
const AUTH_REPEAT_MS = 10_000;

/**
 * States: 'idle' (not needed, or not allowed yet), 'connecting', 'open'
 * (hello received: hints arrive), 'backoff' (waiting to reconnect),
 * 'stopped' (signed out, or stop()), 'unavailable' (the server refuses or
 * cannot be reached: tried again later). Events: 'state' (the new state),
 * 'open' (the hello), 'close' ({ code }), 'auth' (the sign-in session
 * ended: 4001 or 4003; the page asks who is signed in).
 */
export class RealtimeClient extends Emitter {
  /**
   * @param {object} [o]
   * @param {string} [o.path] '/api/account/realtime' or '/api/admin/realtime'
   * @param {typeof WebSocket} [o.WebSocketImpl]
   * @param {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [o.timers]
   * @param {Document | null} [o.doc] for the tab's visibility
   * @param {{ protocol: string, host: string } | null} [o.location]
   * @param {() => number} [o.random]
   * @param {() => number} [o.now]
   */
  constructor({ path = '/api/account/realtime', WebSocketImpl = globalThis.WebSocket, timers = globalThis, doc = globalThis.document ?? null, location = globalThis.location ?? null, random = Math.random, now = () => Date.now() } = {}) {
    super();
    this.path = path;
    this.WebSocketImpl = WebSocketImpl;
    this.timers = timers;
    this.doc = doc;
    this.location = location;
    this.random = random;
    this._state = 'idle';
    this.allowed = false;
    this.ws = null;
    this.helloSeen = false;
    /** Reconnects since the last hello (the backoff's exponent), and connects that failed before any hello. */
    this.attempt = 0;
    this.failures = 0;
    /** `seq` of the last hello or event (an event with a smaller one is a duplicate). */
    this.lastSeq = 0;
    /** topic -> Set of callbacks. */
    this.subs = new Map();
    /** topic -> events waiting for the debounce (or for the tab to show). */
    this.pending = new Map();
    this.flushTimers = new Map();
    this.backoffTimer = null;
    this.lingerTimer = null;
    this.unavailableTimer = null;
    this.pingTimer = null;
    /** The backoff ended while the tab was hidden: connect when it shows. */
    this.reconnectOnShow = false;
    this.onVisibility = () => this.visibilityChanged();
    this.listening = false;
    /** When the last 4001 or 4003 came (a loop guard). */
    this.lastAuthClose = -Infinity;
    this.now = now;
  }

  get state() {
    return this._state;
  }

  setState(state) {
    if (this._state === state) return;
    this._state = state;
    this.emit('state', state);
  }

  get hidden() {
    return this.doc?.visibilityState === 'hidden';
  }

  /** How many callbacks follow any topic. */
  subscriberCount() {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  /**
   * Follow `topic`: `fn(event)` runs on each (debounced) hint with the last
   * event and `event.batch` (every event since the last call), and once
   * after every (re)connect with `{ t: 'event', kind: 'resync', topic }`.
   * Returns the function that stops following.
   */
  subscribe(topic, fn) {
    if (!this.subs.has(topic)) this.subs.set(topic, new Set());
    const entry = (e) => fn(e);
    this.subs.get(topic).add(entry);
    this.sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subs.get(topic)?.delete(entry);
      if (!this.subs.get(topic)?.size) {
        this.subs.delete(topic);
        this.pending.delete(topic);
        this.clearFlush(topic);
      }
      this.sync();
    };
  }

  /** May connect (someone is signed in); it does once a topic has a subscriber. */
  allow() {
    this.allowed = true;
    if (this._state === 'stopped') this.setState('idle');
    this.listen(true);
    this.sync();
  }

  /** Same as allow(): open when a topic needs it (idempotent). */
  start() {
    this.allow();
  }

  /** Close (1000) and stay closed until allow() (signed out). */
  stop() {
    this.allowed = false;
    this.listen(false);
    this.clearTimers();
    this.closeSocket(1000, 'stopped');
    this.failures = 0;
    this.attempt = 0;
    for (const topic of this.pending.keys()) this.clearFlush(topic);
    this.pending.clear();
    this.setState('stopped');
  }

  listen(on) {
    if (on === this.listening || !this.doc?.addEventListener) return;
    this.listening = on;
    if (on) this.doc.addEventListener('visibilitychange', this.onVisibility);
    else this.doc.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Connect, linger or close as the subscribers and the permission say. */
  sync() {
    const wanted = this.allowed && this.subscriberCount() > 0;
    if (!wanted) {
      if (this.ws && this.lingerTimer === null) {
        this.lingerTimer = this.timers.setTimeout(() => {
          this.lingerTimer = null;
          if (this.allowed && this.subscriberCount() > 0) return;
          this.closeSocket(1000, 'unused');
          this.setState(this.allowed ? 'idle' : this._state);
        }, REALTIME_LINGER_MS);
      }
      if (!this.ws && this.backoffTimer !== null) {
        this.timers.clearTimeout(this.backoffTimer);
        this.backoffTimer = null;
        if (this._state === 'backoff') this.setState('idle');
      }
      return;
    }
    if (this.lingerTimer !== null) {
      this.timers.clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.ws || this.backoffTimer !== null || this._state === 'unavailable' || this._state === 'stopped') return;
    this.connect();
  }

  connect() {
    this.reconnectOnShow = false;
    const loc = this.location;
    if (typeof this.WebSocketImpl !== 'function' || !loc?.host) {
      // No sockets here (an old browser, a test page): the screens poll.
      this.setState('unavailable');
      return;
    }
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new this.WebSocketImpl(`${scheme}//${loc.host}${this.path}`);
    } catch {
      this.failed(1006);
      return;
    }
    this.ws = ws;
    this.helloSeen = false;
    this.setState('connecting');
    ws.onmessage = (e) => {
      if (this.ws === ws) this.received(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.closed(e?.code ?? 1006);
    };
    ws.onerror = () => {
      // The close event follows.
    };
  }

  /** Close our own socket without the close handler's reconnect. */
  closeSocket(code, reason) {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close(code, reason);
    } catch {
      // Closed already.
    }
  }

  received(text) {
    const r = parseRealtimeMessage(typeof text === 'string' ? text : '');
    if (!r.ok) {
      // A message this client does not understand (a newer server): poll instead for a while.
      this.closeSocket(1003, 'unsupported');
      this.unavailable();
      this.emit('close', { code: 1003 });
      return;
    }
    const msg = r.msg;
    if (msg.t === 'hello') {
      this.helloSeen = true;
      this.attempt = 0;
      this.failures = 0;
      this.lastSeq = msg.seq;
      this.setState('open');
      this.startPing();
      this.emit('open', msg);
      // Every screen loads its document again: hints may have been missed while closed.
      for (const topic of this.subs.keys()) this.queue(topic, { t: 'event', v: msg.v, seq: msg.seq, topic, kind: 'resync', at: this.now(), data: null });
      return;
    }
    if (msg.t === 'event') {
      if (msg.seq <= this.lastSeq) return;
      this.lastSeq = msg.seq;
      // The hub ends this sign-in (its close frame may take a while to arrive): act on it now.
      if (msg.topic === 'account' && msg.kind === 'signed_out') {
        this.closeSocket(1000, 'signed_out');
        this.closed(REALTIME_CLOSE.SIGNED_OUT);
        return;
      }
      if (this.subs.has(msg.topic)) this.queue(msg.topic, msg);
    }
  }

  queue(topic, event) {
    if (!this.pending.has(topic)) this.pending.set(topic, []);
    this.pending.get(topic).push(event);
    // A hidden tab loads nothing: the topic waits until the tab shows.
    if (this.hidden || this.flushTimers.has(topic)) return;
    this.flushTimers.set(
      topic,
      this.timers.setTimeout(() => {
        this.flushTimers.delete(topic);
        this.flush(topic);
      }, REALTIME_REFETCH_DEBOUNCE_MS),
    );
  }

  clearFlush(topic) {
    const t = this.flushTimers.get(topic);
    if (t !== undefined) this.timers.clearTimeout(t);
    this.flushTimers.delete(topic);
  }

  /** Call the topic's subscribers once with the last waiting event (and all of them in `batch`). */
  flush(topic) {
    const batch = this.pending.get(topic) ?? [];
    this.pending.delete(topic);
    if (!batch.length) return;
    const event = { ...batch.at(-1), batch };
    for (const fn of [...(this.subs.get(topic) ?? [])]) {
      try {
        fn(event);
      } catch (err) {
        console.error('realtime subscriber failed', err);
      }
    }
  }

  closed(code) {
    this.ws = null;
    this.stopPing();
    const hadHello = this.helloSeen;
    this.helloSeen = false;
    this.emit('close', { code });
    if (code === REALTIME_CLOSE.SIGNED_OUT || code === REALTIME_CLOSE.FORBIDDEN) {
      // The sign-in session ended: no reconnect until the page knows who is signed in.
      const repeat = this.now() - this.lastAuthClose < AUTH_REPEAT_MS;
      this.lastAuthClose = this.now();
      if (repeat) {
        this.unavailable();
        return;
      }
      this.clearTimers();
      this.setState('stopped');
      this.emit('auth', code);
      return;
    }
    if (hadHello) this.failures = 0;
    this.failed(code, hadHello);
  }

  /** A connect failed or an open socket dropped: back off, or give up for a while after REALTIME_FAILURES_MAX. */
  failed(_code, hadHello = false) {
    if (!hadHello) this.failures++;
    if (this.failures >= REALTIME_FAILURES_MAX) {
      this.unavailable();
      return;
    }
    if (!this.allowed || this.subscriberCount() === 0) {
      this.setState(this.allowed ? 'idle' : 'stopped');
      return;
    }
    // Full jitter: anywhere from 0 to the doubled step, at most REALTIME_BACKOFF_MAX_MS.
    const step = Math.min(REALTIME_BACKOFF_MAX_MS, REALTIME_BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    const delay = Math.floor(this.random() * step);
    this.setState('backoff');
    this.backoffTimer = this.timers.setTimeout(() => {
      this.backoffTimer = null;
      if (this.hidden) {
        this.reconnectOnShow = true;
        return;
      }
      this.sync();
    }, delay);
  }

  unavailable() {
    this.clearTimers();
    this.failures = 0;
    this.attempt = 0;
    this.setState('unavailable');
    this.unavailableTimer = this.timers.setTimeout(() => {
      this.unavailableTimer = null;
      if (this._state !== 'unavailable') return;
      this.setState('idle');
      this.sync();
    }, REALTIME_UNAVAILABLE_MS);
  }

  clearTimers() {
    for (const k of ['backoffTimer', 'lingerTimer', 'unavailableTimer']) {
      if (this[k] !== null) this.timers.clearTimeout(this[k]);
      this[k] = null;
    }
    this.reconnectOnShow = false;
    this.stopPing();
  }

  startPing() {
    this.stopPing();
    if (this.hidden || !this.ws) return;
    this.pingTimer = this.timers.setInterval(() => {
      try {
        this.ws?.send(REALTIME_PING);
      } catch {
        // The close event follows.
      }
    }, REALTIME_PING_MS);
  }

  stopPing() {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Hidden: no pings, no loads. Shown: what waited loads now, a closed channel reconnects at once. */
  visibilityChanged() {
    if (this.hidden) {
      this.stopPing();
      return;
    }
    if (this._state === 'open') this.startPing();
    for (const topic of [...this.pending.keys()]) {
      this.clearFlush(topic);
      this.flush(topic);
    }
    if (this.reconnectOnShow || this._state === 'backoff') {
      if (this.backoffTimer !== null) this.timers.clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
      this.reconnectOnShow = false;
      this.attempt = 0;
      this.sync();
    }
  }
}
