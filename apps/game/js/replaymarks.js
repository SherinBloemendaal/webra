// Marks on the replay's seek bar (js/records.js ReplayBar): where something
// happened in the parts of the replay already watched. A replay file holds
// only orders, so the marks come from the observer statistics while it plays
// (Game.observer_stats, every frame):
//
// - defeat: a player is out of the game, at the exact tick the engine
//   recorded (`defeatedAt`), also when a seek ran past it;
// - building: a structure was destroyed (the players' `buildingsLost` grew);
// - battle: heavy fighting, BATTLE_LOSSES units or more lost by all players
//   together within BATTLE_WINDOW ticks.
//
// Losses count only between frames that follow each other while playing
// (at most MAX_GAP ticks apart, past the furthest tick seen so far): a seek
// re-simulates many ticks at once, and watching a part again adds nothing.
// Marks closer than MERGE of the replay's length are one mark (the more
// important kind wins). Presentation only: nothing here reaches the game.

/** Mark kinds, most important first, with what each one means (the seek bar's legend). */
export const MARK_KINDS = Object.freeze({
  defeat: 'A player was defeated',
  building: 'A structure was destroyed',
  battle: 'Heavy fighting',
});
const RANK = Object.freeze({ defeat: 0, building: 1, battle: 2 });

/** Ticks of the heavy fighting window (10 s at 25 ticks per second). */
export const BATTLE_WINDOW = 250;
/** Units lost by all players within BATTLE_WINDOW that make heavy fighting. */
export const BATTLE_LOSSES = 6;
/** Frames further apart than this (a seek, a stall) count no losses. */
export const MAX_GAP = 125;
/** Marks closer than this share of the replay's length merge. */
export const MERGE = 0.01;

const sum = (players, key) => players.reduce((n, p) => n + (Number(p?.[key]) || 0), 0);

export class ReplayMarks {
  /** @param {number} length the replay's length in ticks */
  constructor(length) {
    this.length = Math.max(1, length);
    /** `{ tick, kind }` in tick order. */
    this.marks = [];
    /** The furthest tick sampled. */
    this.seen = -1;
    /** The previous sample: `{ tick, units, buildings }`, or null after a jump. */
    this.last = null;
    /** Units lost per frame within BATTLE_WINDOW: `{ tick, lost }`. */
    this.window = [];
    this.lastBattle = -Infinity;
    this.defeated = new Set();
  }

  /**
   * One frame's observer statistics (`players`: Game.observer_stats) at
   * `tick`. Returns true when the marks changed.
   */
  observe(players, tick) {
    if (!Array.isArray(players) || !Number.isFinite(tick)) return false;
    let changed = false;
    for (const p of players) {
      if (!p?.defeated || this.defeated.has(p.player)) continue;
      this.defeated.add(p.player);
      if (Number.isFinite(p.defeatedAt)) changed = this.add('defeat', p.defeatedAt) || changed;
    }
    const now = { tick, units: sum(players, 'unitsLost'), buildings: sum(players, 'buildingsLost') };
    const last = this.last;
    if (last && tick > this.seen && tick > last.tick && tick - last.tick <= MAX_GAP) {
      if (now.buildings > last.buildings) changed = this.add('building', tick) || changed;
      const lost = Math.max(0, now.units - last.units);
      if (lost > 0) this.window.push({ tick, lost });
      while (this.window.length && this.window[0].tick <= tick - BATTLE_WINDOW) this.window.shift();
      const inWindow = this.window.reduce((n, w) => n + w.lost, 0);
      if (inWindow >= BATTLE_LOSSES && tick - this.lastBattle > BATTLE_WINDOW) {
        this.lastBattle = tick;
        this.window = [];
        changed = this.add('battle', tick) || changed;
      }
    } else if (!last || tick <= last.tick || tick - last.tick > MAX_GAP) {
      // A jump (seek) or the first frame: losses count again from here.
      this.window = [];
    }
    this.last = now;
    this.seen = Math.max(this.seen, tick);
    return changed;
  }

  /**
   * A seek: the ticks it skips were not watched, so the next frame only sets
   * the baseline again (however short the step).
   */
  jump() {
    this.last = null;
    this.window = [];
  }

  /** Add a mark, merged with one close by. Returns true when the marks changed. */
  add(kind, tick) {
    const t = Math.max(0, Math.min(this.length, Math.round(tick)));
    const near = this.marks.find((m) => Math.abs(m.tick - t) <= this.length * MERGE);
    if (near) {
      if (RANK[kind] >= RANK[near.kind]) return false;
      near.kind = kind;
      return true;
    }
    this.marks.push({ tick: t, kind });
    this.marks.sort((a, b) => a.tick - b.tick);
    return true;
  }

  /** Where a mark sits on the bar, as a share of the length (0..1). */
  at(mark) {
    return mark.tick / this.length;
  }
}
