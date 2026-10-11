// The announcer speaks one line at a time. Lines wait in a short queue; a
// line that waited too long is dropped (old news), and the same line is never
// queued twice. Playing a line is delegated (index.js), so the queue rules are
// unit tested without audio.
//
// While the game is paused the lines of the simulation (engine events, player
// state, mission scripts) wait: none starts during the pause, like OpenRA,
// whose notifications come from world ticks. The line playing when the pause
// began finishes. Lines of the player's own clicks (production, support
// powers) still play, as OpenRA's widgets play them in a paused game. Waiting
// time only counts while the game runs, so held lines play after the pause.

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
    this.paused = false;
    /** Seconds the game stood still before the current pause, and when that pause began. */
    this.pausedFor = 0;
    this.pausedAt = 0;
  }

  /** Seconds of running game: the page clock without the pauses. */
  clock() {
    return this.now() - this.pausedFor - (this.paused ? this.now() - this.pausedAt : 0);
  }

  /**
   * Queue a line. `world`: it comes from the simulation, so it waits while
   * the game is paused.
   * @param {string} key
   * @param {{ world?: boolean }} [o]
   */
  push(key, { world = false } = {}) {
    if (this.current === key) return false;
    const queued = this.queue.find((q) => q.key === key);
    if (queued) {
      // The player asked for a line the simulation's is waiting with: it plays now.
      if (world || !queued.world) return false;
      queued.world = false;
      this.pump();
      return true;
    }
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push({ key, at: this.clock(), world });
    this.pump();
    return true;
  }

  /** The game paused or went on: simulation lines wait meanwhile. */
  setPaused(paused) {
    if (paused === this.paused) return;
    if (paused) this.pausedAt = this.now();
    else this.pausedFor += this.now() - this.pausedAt;
    this.paused = paused;
    if (!paused) this.pump();
  }

  /** The next line that may play now, or null (stale lines are dropped on the way). */
  next() {
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i];
      if (this.clock() - item.at > this.maxWait) {
        this.queue.splice(i, 1);
        continue;
      }
      if (this.paused && item.world) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      return item;
    }
    return null;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let item = this.next(); item; item = this.next()) {
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
