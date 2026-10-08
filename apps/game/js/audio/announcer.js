// The announcer speaks one line at a time. Lines wait in a short queue; a
// line that waited too long is dropped (old news), and the same line is never
// queued twice. Playing a line is delegated (index.js), so the queue rules are
// unit tested without audio.

export const MAX_QUEUE = 3;
/** Seconds a line may wait before it is dropped. */
export const MAX_WAIT = 4;

export class Announcer {
  /**
   * @param {{ play(key: string): Promise<void>, now(): number }} o
   */
  constructor({ play, now, maxQueue = MAX_QUEUE, maxWait = MAX_WAIT }) {
    this.play = play;
    this.now = now;
    this.maxQueue = maxQueue;
    this.maxWait = maxWait;
    this.queue = [];
    this.busy = false;
    this.current = null;
  }

  push(key) {
    if (this.current === key || this.queue.some((q) => q.key === key)) return false;
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push({ key, at: this.now() });
    this.pump();
    return true;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        if (this.now() - item.at > this.maxWait) continue;
        this.current = item.key;
        try {
          await this.play(item.key);
        } catch {
          // A line that fails to play must not stall the announcer.
        }
        this.current = null;
      }
    } finally {
      this.busy = false;
    }
  }

  clear() {
    this.queue = [];
  }
}
