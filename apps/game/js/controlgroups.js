// Control groups (OpenRA's ControlGroups): the keys come from the hotkey
// registry (js/input.js registers OpenRA's ControlGroup* hotkeys): 1..9, 0
// select a group (a quick second press centres the camera on it), Ctrl (Cmd
// on macOS) creates one from the selection, Ctrl+Shift adds the selection to
// one, Shift adds a group to the selection, Alt jumps to it. An actor belongs
// to one group at a time, like the original. No DOM here, so it is tested headless.
//
// `version` grows with every change, so js/input.js hands the groups to the
// engine (the numbers on selection boxes, `Game.set_control_groups`) only
// when they changed.

export const DOUBLE_TAP_MS = 400;

export class ControlGroups {
  constructor({ doubleTapMs = DOUBLE_TAP_MS } = {}) {
    this.doubleTapMs = doubleTapMs;
    this.groups = new Map(); // key -> ids
    this.lastTap = { key: null, time: -Infinity };
    this.version = 0;
  }

  /** Set group `key` to `ids` (none: drop it); counts a change only when the members differ. */
  put(key, ids) {
    const old = this.groups.get(key);
    if (ids.length) this.groups.set(key, ids);
    else this.groups.delete(key);
    const same = old ? old.length === ids.length && old.every((id, i) => id === ids[i]) : ids.length === 0;
    if (!same) this.version++;
  }

  /** Store `ids` as group `key`, taking them out of any other group. Empty ids clear the group. */
  assign(key, ids) {
    const set = new Set(ids);
    for (const [k, members] of [...this.groups]) {
      if (k === key) continue;
      this.put(k, members.filter((id) => !set.has(id)));
    }
    this.put(key, [...set]);
    this.lastTap = { key: null, time: -Infinity };
  }

  /** Add `ids` to group `key`, taking them out of any other group (OpenRA AddSelectionToControlGroup). */
  add(key, ids) {
    const keep = this.groups.get(key) ?? [];
    this.assign(key, [...keep, ...ids]);
  }

  /** Take `ids` out of whatever group they are in (OpenRA RemoveFromControlGroup). */
  remove(ids) {
    const set = new Set(ids);
    for (const [k, members] of [...this.groups]) this.put(k, members.filter((id) => !set.has(id)));
  }

  /** Members of a group still accepted by `alive` (dead ones are dropped for good). */
  members(key, alive = (ids) => ids) {
    const ids = this.groups.get(key);
    if (!ids) return [];
    const left = alive(ids);
    this.put(key, left);
    return left;
  }

  /** Drop the members `alive` no longer accepts from every group (actors that died or changed owner). */
  prune(alive) {
    for (const key of [...this.groups.keys()]) this.members(key, alive);
  }

  /** Every member and its group number, for the engine: `{ ids, groups }` (Uint32Array, Uint8Array). */
  entries() {
    const ids = [];
    const groups = [];
    for (const [k, members] of this.groups) {
      for (const id of members) {
        ids.push(id);
        groups.push(Number(k));
      }
    }
    return { ids: Uint32Array.from(ids), groups: Uint8Array.from(groups) };
  }

  /**
   * Press of a group key without Ctrl: returns { ids, center } where `center`
   * is true on a quick second press of the same key.
   */
  recall(key, now, alive) {
    const ids = this.members(key, alive);
    const center = ids.length > 0 && this.lastTap.key === key && now - this.lastTap.time <= this.doubleTapMs;
    this.lastTap = center ? { key: null, time: -Infinity } : { key, time: now };
    return { ids, center };
  }

  has(key) {
    return this.groups.has(key);
  }
}
