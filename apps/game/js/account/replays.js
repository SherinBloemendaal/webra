// Replays kept in the account (docs/accounts-api.md 5.10): the background
// upload of every game's replay, and what the replay lists (the game's
// Replays dialog and the account page) show.
//
// - When a game ends, or the player leaves it early, the game encodes its
//   replay and queues it here (GameReplay). Only while signed in to an
//   active account, with "Save replays to my account" on
//   (`privacy.cloudReplays`) and a server that keeps replays.
// - The queue lives in IndexedDB (its own database, UPLOAD_DB), so a replay
//   queued while leaving (the page reloads right after) or while offline is
//   uploaded on the next start. Uploads run one at a time, in the
//   background; failures that can pass (offline, 5xx, 429) are retried with
//   a growing pause, the others are dropped and reported once.
// - A queued replay belongs to the account that played it: it waits for
//   that account to sign in again and is dropped after QUEUE_MAX_AGE_MS.

import { AccountError } from './api.js';
import { ACCOUNT_REPLAY_MAX_BYTES } from '../../protocol/constants.js';

const DAY = 24 * 60 * 60 * 1000;
export const UPLOAD_DB = 'webra-replay-uploads';
const STORE = 'pending';
/** Replays waiting at most (the oldest are dropped first). */
export const QUEUE_MAX = 10;
export const QUEUE_MAX_AGE_MS = 7 * DAY;
/** Pause before the first retry; it doubles each time up to RETRY_MAX_MS. */
export const RETRY_BASE_MS = 5000;
export const RETRY_MAX_MS = 30 * 60 * 1000;
/** Tries before a replay is given up. */
export const MAX_ATTEMPTS = 8;
/** How long leaving a game waits at most for its replay to be queued. */
export const LEAVE_WAIT_MS = 3000;

/** In-memory queue storage (tests, browsers without IndexedDB). */
export class MemoryQueue {
  constructor() {
    this.rows = new Map();
  }
  async all() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async put(row) {
    this.rows.set(row.key, { ...row });
  }
  async remove(key) {
    this.rows.delete(key);
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB queue storage: one object store keyed by the game. */
export class IdbQueue {
  constructor(idb) {
    this.idb = idb;
    this.db = null;
  }
  async open() {
    if (this.db) return this.db;
    const req = this.idb.open(UPLOAD_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    this.db = await request(req);
    return this.db;
  }
  async store(mode) {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }
  async all() {
    return request((await this.store('readonly')).getAll());
  }
  async put(row) {
    await request((await this.store('readwrite')).put(row));
  }
  async remove(key) {
    await request((await this.store('readwrite')).delete(key));
  }
}

/** The queue storage of this browser: IndexedDB, or memory when the browser has none. */
export function browserQueue() {
  try {
    if (globalThis.indexedDB) return new IdbQueue(globalThis.indexedDB);
  } catch {
    // blocked storage
  }
  return new MemoryQueue();
}

/**
 * How the game ended for this player, from the end-of-game flow
 * (js/endgame.js EndGameFlow): `spectated` for a spectator, `won` or `lost`
 * once decided, `left` when the player leaves before.
 */
export function replayResult(flow, { spectator = false } = {}) {
  if (spectator) return 'spectated';
  if (!flow) return 'unknown';
  if (flow.phase === 'won') return 'won';
  if (flow.over) return flow.won ? 'won' : 'lost';
  if (flow.phase === 'lost') return 'lost';
  return 'left';
}

/**
 * Whether a game's replay goes to the account: an active account is signed
 * in, the setting is on and the server keeps replays (`services.replays`;
 * unknown counts as yes, the server answers 503 otherwise).
 */
export function uploadsWanted({ user, site, enabled }) {
  return !!user && user.status === 'active' && enabled === true && site?.services?.replays !== false;
}

/**
 * The upload queue. `onEvent` hears `{ type: 'uploaded', replay, duplicate,
 * evicted }`, `{ type: 'failed', message }` (given up),
 * `{ type: 'unavailable', message }` (this server keeps no replays) and
 * `{ type: 'too_large' }` (not queued).
 */
export class ReplayUploads {
  /**
   * @param {{ api: import('./api.js').AccountApi, queue?: MemoryQueue | IdbQueue, onEvent?: (e: object) => void,
   *   now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function } }} o
   */
  constructor({ api, queue = new MemoryQueue(), onEvent = () => {}, now = () => Date.now(), timers = globalThis }) {
    this.api = api;
    this.queue = queue;
    this.onEvent = onEvent;
    this.now = now;
    this.timers = timers;
    /** The account whose replays go up now (null: none). */
    this.userId = null;
    this.timer = null;
    this.running = null;
    this.again = false;
  }

  /**
   * Queue a replay (`key`: one per game, a later one replaces it) and start
   * uploading. Resolves false when it was not queued (too large).
   */
  async add({ userId, key, text, result = 'unknown' }) {
    if (new TextEncoder().encode(text).byteLength > ACCOUNT_REPLAY_MAX_BYTES) {
      this.onEvent({ type: 'too_large' });
      return false;
    }
    await this.queue.remove(key);
    await this.prune(1);
    await this.queue.put({ key, userId, text, result, queuedAt: this.now(), attempts: 0, nextAt: 0 });
    if (userId === this.userId) this.schedule(0);
    return true;
  }

  /** Upload the replays of this account (signed in, setting on). */
  start(userId) {
    if (this.userId === userId) return;
    this.userId = userId;
    this.schedule(0);
  }

  /** Stop uploading (signed out, setting off, another server). Queued replays stay. */
  stop() {
    this.userId = null;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drop the queued replays of an account (the player switched the setting off). */
  async clear(userId) {
    for (const row of await this.queue.all()) if (row.userId === userId) await this.queue.remove(row.key);
  }

  schedule(ms) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.run().catch((err) => console.warn('replay upload failed:', err));
    }, Math.max(0, ms));
  }

  /** Too old, or too many (`room`: places to free for new ones): the oldest go. */
  async prune(room = 0) {
    const rows = (await this.queue.all()).sort((a, b) => a.queuedAt - b.queuedAt);
    const now = this.now();
    let keep = rows.length;
    for (const row of rows) {
      if (now - row.queuedAt > QUEUE_MAX_AGE_MS || keep > QUEUE_MAX - room) {
        await this.queue.remove(row.key);
        keep--;
      }
    }
  }

  /** One pass over the due replays of the current account; one pass at a time. */
  async run() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && this.userId);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async pass() {
    if (!this.userId) return;
    await this.prune();
    const userId = this.userId;
    const rows = (await this.queue.all()).filter((r) => r.userId === userId).sort((a, b) => a.queuedAt - b.queuedAt);
    let next = Infinity;
    for (const row of rows) {
      if (this.userId !== userId) return;
      if (row.nextAt > this.now()) {
        next = Math.min(next, row.nextAt);
        continue;
      }
      const outcome = await this.upload(row);
      if (outcome === 'stop') return;
      if (outcome === 'retry') next = Math.min(next, row.nextAt);
    }
    if (next !== Infinity && this.userId === userId) this.schedule(next - this.now());
  }

  /** Upload one row: 'done', 'retry' (rescheduled) or 'stop' (wait for the next sign-in). */
  async upload(row) {
    try {
      const r = await this.api.uploadReplay(row.text, row.result);
      await this.queue.remove(row.key);
      this.onEvent({ type: 'uploaded', replay: r.replay, duplicate: !!r.duplicate, evicted: r.evicted ?? 0 });
      return 'done';
    } catch (err) {
      const status = err instanceof AccountError ? err.status : -1;
      const code = err instanceof AccountError ? err.code : '';
      // Signed out or not allowed now: wait for the next sign-in (start). An answer for an
      // account that is no longer the current one (signed out and another signed in while
      // it ran) leaves the new account's uploads alone.
      if (status === 401 || (status === 403 && code !== 'csrf')) {
        if (this.userId === row.userId) this.stop();
        return 'stop';
      }
      if (status === 503 && code === 'unavailable') {
        await this.queue.remove(row.key);
        this.onEvent({ type: 'unavailable', message: err.message });
        return 'done';
      }
      const passing = status === 0 || status === 429 || status >= 500 || status === -1;
      row.attempts += 1;
      if (passing && row.attempts < MAX_ATTEMPTS) {
        const wait = status === 429 && err.detail?.retryAfter ? err.detail.retryAfter * 1000 : Math.min(RETRY_BASE_MS * 2 ** (row.attempts - 1), RETRY_MAX_MS);
        row.nextAt = this.now() + wait;
        await this.queue.put(row);
        return 'retry';
      }
      await this.queue.remove(row.key);
      this.onEvent({ type: 'failed', message: err?.message ?? String(err) });
      return 'done';
    }
  }
}

/**
 * Drop the replays an account left waiting in this browser's queue (an
 * explicit sign-out: they would otherwise wait up to QUEUE_MAX_AGE_MS for
 * that account to sign in again). Never rejects.
 */
export async function clearQueuedReplays(userId, queue = browserQueue()) {
  try {
    for (const row of await queue.all()) if (row.userId === userId) await queue.remove(row.key);
  } catch {
    // blocked storage: nothing was kept either
  }
}

/** sessionStorage key of a replay to open once signed in (`/play/#replay=<id>`). */
export const REPLAY_LINK_KEY = 'webra.replayLink.v1';
export const REPLAY_LINK_RE = /^#replay=([0-9a-f]{16})$/;

/**
 * The replay a link asks to open: from the address (`#replay=<id>`, kept in
 * `storage` until it is opened, so it survives signing in) or one kept
 * earlier. Returns the id or null; `take` forgets it.
 */
export function replayLink(hash, storage) {
  const m = REPLAY_LINK_RE.exec(hash ?? '');
  try {
    if (m) storage?.setItem(REPLAY_LINK_KEY, m[1]);
    const kept = storage?.getItem(REPLAY_LINK_KEY) ?? null;
    return kept && /^[0-9a-f]{16}$/.test(kept) ? kept : m ? m[1] : null;
  } catch {
    return m ? m[1] : null;
  }
}

export function forgetReplayLink(storage) {
  try {
    storage?.removeItem(REPLAY_LINK_KEY);
  } catch {
    // nothing kept
  }
}

/** Toast text for an upload event (js/main.js showToast), or null for none. */
export function uploadEventText(e) {
  switch (e.type) {
    case 'uploaded':
      // Already there: the upload before the page reloaded reached the server, and that is all.
      if (e.duplicate) return null;
      return e.evicted ? `Replay saved to your account (the oldest ${e.evicted === 1 ? 'one was' : `${e.evicted} were`} removed to make room).` : 'Replay saved to your account.';
    case 'failed':
      return `The replay could not be saved to your account: ${e.message}`;
    case 'unavailable':
      return 'This server does not keep replays in accounts.';
    case 'too_large':
      return 'This replay is too large to keep in your account. Download it from the game menu instead.';
    default:
      return null;
  }
}

/**
 * One game's replay for the account: queued once, when the game ends
 * (`ended`) or when the player leaves it first (`leaving`, which waits at
 * most LEAVE_WAIT_MS so leaving never hangs).
 */
export class GameReplay {
  /**
   * @param {{ recorder: { start: { createdAt: number, title: string }, encode(kind: string): Promise<{ text: string }> },
   *   uploads: ReplayUploads, account: () => { user: object | null, site: object | null }, enabled: () => boolean,
   *   timers?: { setTimeout: Function, clearTimeout: Function } }} o
   */
  constructor({ recorder, uploads, account, enabled, timers = globalThis }) {
    this.recorder = recorder;
    this.uploads = uploads;
    this.account = account;
    this.enabled = enabled;
    this.timers = timers;
    this.queued = null;
  }

  /** The game ended: queue its replay in the background. */
  ended(result) {
    return this.queue(result);
  }

  /** The player leaves the page: queue the replay unless it was, waiting a moment at most. */
  leaving(result) {
    const p = this.queue(result);
    return new Promise((resolve) => {
      const t = this.timers.setTimeout(resolve, LEAVE_WAIT_MS);
      p.finally(() => {
        this.timers.clearTimeout(t);
        resolve();
      });
    });
  }

  queue(result) {
    if (this.queued) return this.queued;
    const { user, site } = this.account() ?? {};
    if (!uploadsWanted({ user, site, enabled: this.enabled() })) {
      this.queued = Promise.resolve(false);
      return this.queued;
    }
    const key = `${user.id}:${this.recorder.start.createdAt}:${this.recorder.start.title}`;
    this.queued = this.recorder
      .encode('replay')
      .then(({ text }) => this.uploads.add({ userId: user.id, key, text, result }))
      .catch((err) => {
        console.warn('Could not queue the replay for the account:', err);
        return false;
      });
    return this.queued;
  }
}

// ---- What the lists show ------------------------------------------------------------------

export const RESULT_LABELS = Object.freeze({ won: 'Won', lost: 'Lost', left: 'Left early', spectated: 'Watched', unknown: 'Unknown' });
export const MODE_LABELS = Object.freeze({ skirmish: 'Skirmish', online: 'Online', mission: 'Mission' });

/** "1.2 MB", "340 KB" (1024 based, like the limits). */
export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Whole days until `expiresAt` (at least 1 while it is in the future, 0 after). */
export function daysLeft(expiresAt, now = Date.now()) {
  return expiresAt <= now ? 0 : Math.max(1, Math.ceil((expiresAt - now) / DAY));
}

export const daysLeftText = (expiresAt, now) => {
  const d = daysLeft(expiresAt, now);
  return d === 1 ? '1 day left' : `${d} days left`;
};

/** "Tanya, Boris and AI (3)": people by name, AIs counted. */
export function playersText(players) {
  const names = players.filter((p) => p.type === 'human' && p.name).map((p) => p.name);
  const ai = players.filter((p) => p.type !== 'human').length;
  const parts = [...names, ...(ai ? [ai === 1 ? '1 AI' : `${ai} AIs`] : [])];
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** "m:ss" or "h:mm:ss" of a length in ticks (25 per second). */
export function durationText(ticks) {
  const secs = Math.floor(ticks / 25);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "12 of 100 replays, 3.4 MB of 100 MB". */
export function usageText(usage, limits) {
  return `${usage.count} of ${limits.count} replays, ${formatBytes(usage.bytes)} of ${formatBytes(limits.bytes)}`;
}

/** One line about a replay kept in the account: when, how long, players, map, result, size, days left. */
export function replayLine(r, now = Date.now()) {
  const who = playersText(r.players);
  return [
    `${new Date(r.playedAt).toLocaleString()}, ${durationText(r.ticks)}`,
    `${MODE_LABELS[r.mode] ?? r.mode} on ${r.mapName}${who ? ` with ${who}` : ''}`,
    `${RESULT_LABELS[r.result] ?? r.result}, ${formatBytes(r.size)}, ${daysLeftText(r.expiresAt, now)}`,
  ].join('. ');
}

/** "Online · Tiny · Tanya and 1 AI": the row line of a replay in the game's Replays screen. */
export function replayMeta(r) {
  const who = playersText(r.players ?? []);
  return [MODE_LABELS[r.mode] ?? r.mode, r.mapName, who].filter(Boolean).join(' · ');
}

/**
 * The facts the Replays screen lists for the chosen replay, as `[label, value]`
 * pairs: when, how long, mode, map, players, result, size, how long it is kept
 * and the version that recorded it.
 */
export function replayFacts(r, now = Date.now()) {
  const who = playersText(r.players ?? []);
  return [
    ['Played', new Date(r.playedAt).toLocaleString()],
    ['Length', durationText(r.ticks)],
    ['Mode', MODE_LABELS[r.mode] ?? r.mode],
    ['Map', r.mapName],
    ...(who ? [['Players', who]] : []),
    ['Result', RESULT_LABELS[r.result] ?? r.result],
    ['Size', formatBytes(r.size)],
    ['Kept', daysLeftText(r.expiresAt, now)],
    ['Version', r.engine],
  ];
}

/** The share of the account's replay storage in use (0..1, the larger of count and bytes). */
export function usageShare(usage, limits) {
  const of = (n, max) => (max > 0 ? Math.min(1, Math.max(0, n / max)) : 0);
  return Math.max(of(usage.count, limits.count), of(usage.bytes, limits.bytes));
}
