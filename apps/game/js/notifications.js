// In-game text notifications: the announcer's lines ("Unit ready.",
// "Construction complete.", "Insufficient funds.") written at the bottom of
// the battlefield, like Red Alert and OpenRA. A repeated line does not stack:
// it counts up ("Unit ready. (6)") and stays a little longer. Lines fade out.
//
// These are OpenRA's transient lines (TRANSIENT_LINE_TEMPLATE): the
// announcer's ("Transients") and the UI's feedback ("Feedback"), each pool
// switched off by its setting like OpenRA's TextNotificationPoolFilters
// (game menu, Settings). Chat and system lines are the chat log's
// (js/chatlog.js).
//
// NotificationQueue is the timing and merging logic, without a DOM, so it is
// unit tested (tests/notifications.test.mjs); NotificationView draws it.

import { EVA } from './audio/catalog.js';

/** Lines on screen at once, at most; the oldest goes first. */
export const MAX_LINES = 3;
/** Seconds a line stays fully visible after it was last pushed. */
export const HOLD_SECONDS = 3.5;
/** Seconds the fade out takes after that. */
export const FADE_SECONDS = 1;

/** Notification text of an announcer line (audio/catalog.js EVA key), or null. */
export function announcementText(key) {
  const line = EVA[key];
  if (!line) return null;
  const text = line.text.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export class NotificationQueue {
  constructor({ maxLines = MAX_LINES, hold = HOLD_SECONDS, fade = FADE_SECONDS } = {}) {
    this.maxLines = maxLines;
    this.hold = hold;
    this.fade = fade;
    /** @type {{ id: number, text: string, count: number, at: number }[]} oldest first */
    this.items = [];
    this.nextId = 1;
  }

  /**
   * Show `text` at time `now` (seconds). The same text already on screen
   * counts up and moves to the newest position instead of adding a line.
   * @returns the line's record
   */
  push(text, now) {
    this.prune(now);
    const i = this.items.findIndex((it) => it.text === text);
    let item;
    if (i >= 0) {
      item = this.items.splice(i, 1)[0];
      item.count += 1;
      item.at = now;
    } else {
      item = { id: this.nextId++, text, count: 1, at: now };
    }
    this.items.push(item);
    while (this.items.length > this.maxLines) this.items.shift();
    return item;
  }

  /** Drop lines that finished fading. */
  prune(now) {
    const life = this.hold + this.fade;
    this.items = this.items.filter((it) => now - it.at < life);
  }

  /** Opacity of a line at `now`: 1 while held, then a linear fade to 0. */
  opacity(item, now) {
    const age = now - item.at;
    if (age <= this.hold) return 1;
    if (this.fade <= 0) return 0;
    return Math.max(0, 1 - (age - this.hold) / this.fade);
  }

  /** Visible lines, oldest first, with their label and opacity. */
  lines(now) {
    this.prune(now);
    return this.items.map((it) => ({
      id: it.id,
      text: it.text,
      count: it.count,
      label: it.count > 1 ? `${it.text} (${it.count})` : it.text,
      opacity: this.opacity(it, now),
    }));
  }

  get empty() {
    return this.items.length === 0;
  }

  clear() {
    this.items = [];
  }
}

/**
 * The lines on screen. The visible lines are hidden from screen readers; a
 * separate polite live region reads each new notification once instead
 * (count updates and fades would otherwise be read again and again).
 */
export class NotificationView {
  /**
   * @param {HTMLElement} parent the battlefield (#field)
   * @param {{ now?: () => number, queue?: NotificationQueue, enabled?: (pool: 'transients' | 'feedback') => boolean }} [o]
   *   `enabled`: whether a pool's lines are shown (OpenRA TextNotificationPoolFilters)
   */
  constructor(parent, { now = () => performance.now() / 1000, queue = new NotificationQueue(), enabled = () => true } = {}) {
    this.now = now;
    this.enabled = enabled;
    this.queue = queue;
    this.root = document.createElement('div');
    this.root.id = 'notices';
    this.root.setAttribute('aria-hidden', 'true');
    this.live = document.createElement('div');
    this.live.className = 'ui-sr-only';
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');
    parent.append(this.root, this.live);
    this.nodes = new Map(); // line id -> { el, text, count, label }
    this.frame = 0;
  }

  /** Show a line of text of `pool`: 'transients' (game events) or 'feedback' (UI feedback). */
  push(text, pool = 'transients') {
    if (!text || !this.enabled(pool)) return;
    this.queue.push(text, this.now());
    this.live.textContent = text;
    this.render();
  }

  /** Show the text of an announcer line (EVA key). */
  announce(key) {
    this.push(announcementText(key));
  }

  render() {
    const lines = this.queue.lines(this.now());
    const keep = new Set(lines.map((l) => l.id));
    for (const [id, n] of this.nodes) {
      if (!keep.has(id)) {
        n.el.remove();
        this.nodes.delete(id);
      }
    }
    lines.forEach((line, i) => {
      let n = this.nodes.get(line.id);
      if (!n) {
        const el = document.createElement('div');
        el.className = 'notice';
        const text = document.createElement('span');
        const count = document.createElement('span');
        count.className = 'notice-count';
        el.append(text, count);
        n = { el, text, count, label: '', opacity: -1 };
        this.nodes.set(line.id, n);
      }
      if (n.label !== line.label) {
        n.label = line.label;
        n.text.textContent = line.text;
        n.count.textContent = line.count > 1 ? ` (${line.count})` : '';
      }
      const o = Math.round(line.opacity * 100) / 100;
      if (n.opacity !== o) {
        n.opacity = o;
        n.el.style.opacity = String(o);
      }
      // Oldest first, so the newest line is at the bottom; move nodes only
      // when the order changed (a repeated line moves to the bottom).
      if (this.root.children[i] !== n.el) this.root.insertBefore(n.el, this.root.children[i] ?? null);
    });
    if (!this.queue.empty && !this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }
}
