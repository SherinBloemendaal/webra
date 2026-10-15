// Friends in the game and on the account page (docs/accounts-api.md 5.11):
// the API client, a polling store for the friends screen, and the presence
// heartbeat that tells friends whether this player is around. No DOM except
// the input listeners of PresenceTracker.
//
//   const friends = new FriendsStore();          // signed in only
//   friends.on('change', (doc) => render(doc));  // { friends, incoming, outgoing, blocked, invites, sentInvites, privacy, limits }
//   friends.start();                              // polls every FRIENDS_POLL_MS while shown
//   await friends.request('Ivan');                // every action refreshes the list
//   friends.stop();
//
//   const presence = new PresenceTracker();      // once per page while signed in
//   presence.start();

import { FRIENDS_POLL_MS, PRESENCE_AWAY_MS, PRESENCE_INTERVAL_MS } from '../protocol.js';
import { Emitter } from '../netquality.js';
import { AccountApi, AccountError } from './api.js';

const enc = encodeURIComponent;

/** The friends endpoints. Every method resolves with the parsed answer or throws an AccountError. */
export class FriendsClient {
  constructor(api = new AccountApi()) {
    this.api = api;
  }

  /** `{ friends, incoming, outgoing, blocked, invites, sentInvites, privacy, limits }`. */
  list = () => this.api.get('/api/account/friends');
  /** `{ request }` (waiting) or `{ friend }` when the other player had asked already. */
  request = (username) => this.api.post('/api/account/friends/requests', { username });
  /** `{ friend }`. */
  accept = (username) => this.api.post(`/api/account/friends/requests/${enc(username)}/accept`);
  ignore = (username) => this.api.post(`/api/account/friends/requests/${enc(username)}/ignore`);
  withdraw = (username) => this.api.del(`/api/account/friends/requests/${enc(username)}`);
  remove = (username) => this.api.del(`/api/account/friends/${enc(username)}`);
  block = (username) => this.api.post('/api/account/friends/blocks', { username });
  unblock = (username) => this.api.del(`/api/account/friends/blocks/${enc(username)}`);
  /** Invite a friend into the session this player is in (the lobby needs an invite code). `{ invite }`. */
  invite = (username, session) => this.api.post('/api/account/friends/invites', { username, session });
  /** Dismiss an invite from `username`, or with `sent` withdraw one sent to `username`. */
  dismissInvite = (username, { sent = false } = {}) => this.api.del(`/api/account/friends/invites/${enc(username)}${sent ? '?sent=1' : ''}`);
  /** The presence heartbeat. */
  presence = (away, idleMs = 0) => this.api.post('/api/account/presence', away ? { away: true, idleMs: Math.max(0, Math.round(idleMs)) } : { away: false });
}

/**
 * The friends list, polled while a screen shows it. Events: `change` (the
 * document), `error` (an AccountError; polling goes on unless it was 401 or
 * 403, which stop it: signed out or no longer allowed).
 */
export class FriendsStore extends Emitter {
  constructor({ client = new FriendsClient(), pollMs = FRIENDS_POLL_MS, timers = globalThis } = {}) {
    super();
    this.client = client;
    this.pollMs = pollMs;
    this.timers = timers;
    this.doc = null;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Load the list now (and schedule the next poll while running). Resolves with the document or null. */
  async refresh() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    try {
      this.doc = await this.client.list();
      this.emit('change', this.doc);
      return this.doc;
    } catch (err) {
      this.emit('error', err);
      if (err instanceof AccountError && (err.status === 401 || err.status === 403)) this.running = false;
      return null;
    } finally {
      if (this.running && this.timer === null) this.timer = this.timers.setTimeout(() => this.refresh(), this.pollMs);
    }
  }

  /** Run an action, then refresh; resolves with the action's answer (errors are thrown to the caller). */
  async act(fn) {
    const out = await fn();
    await this.refresh();
    return out;
  }

  request = (username) => this.act(() => this.client.request(username));
  accept = (username) => this.act(() => this.client.accept(username));
  ignore = (username) => this.act(() => this.client.ignore(username));
  withdraw = (username) => this.act(() => this.client.withdraw(username));
  remove = (username) => this.act(() => this.client.remove(username));
  block = (username) => this.act(() => this.client.block(username));
  unblock = (username) => this.act(() => this.client.unblock(username));
  invite = (username, session) => this.act(() => this.client.invite(username, session));
  dismissInvite = (username, o) => this.act(() => this.client.dismissInvite(username, o));
}

/** Input that counts as the player being around. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

/**
 * The presence heartbeat: one every PRESENCE_INTERVAL_MS while the page is
 * open, and at once when the player goes away (no input for
 * PRESENCE_AWAY_MS) or comes back. Errors are ignored; 401 and 403 stop it.
 */
export class PresenceTracker {
  constructor({ client = new FriendsClient(), target = globalThis.document ?? null, now = () => Date.now(), timers = globalThis } = {}) {
    this.client = client;
    this.target = target;
    this.now = now;
    this.timers = timers;
    this.lastInput = now();
    this.away = false;
    this.timer = null;
    this.onInput = () => this.activity();
  }

  start() {
    if (this.timer !== null) return;
    for (const e of ACTIVITY_EVENTS) this.target?.addEventListener?.(e, this.onInput, { passive: true, capture: true });
    this.lastInput = this.now();
    this.away = false;
    this.beat();
    // Checked more often than the heartbeat, so going away is told within a minute.
    this.timer = this.timers.setInterval(() => this.tick(), Math.min(PRESENCE_INTERVAL_MS, 30_000));
    this.lastBeat = this.now();
  }

  stop() {
    for (const e of ACTIVITY_EVENTS) this.target?.removeEventListener?.(e, this.onInput, { capture: true });
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  activity() {
    this.lastInput = this.now();
    if (this.away) {
      this.away = false;
      this.beat();
    }
  }

  tick() {
    const now = this.now();
    const idle = now - this.lastInput;
    if (!this.away && idle >= PRESENCE_AWAY_MS) {
      this.away = true;
      this.beat();
      return;
    }
    if (now - this.lastBeat >= PRESENCE_INTERVAL_MS - 1000) this.beat();
  }

  beat() {
    this.lastBeat = this.now();
    const idle = this.now() - this.lastInput;
    this.client.presence(this.away, this.away ? idle : 0).catch((err) => {
      if (err instanceof AccountError && (err.status === 401 || err.status === 403)) this.stop();
    });
  }
}
