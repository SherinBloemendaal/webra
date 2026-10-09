// Control groups (OpenRA's ControlGroups): the keys come from the hotkey
// registry (js/input.js registers OpenRA's ControlGroup* hotkeys): 1..9, 0
// select a group (a quick second press centres the camera on it), Ctrl (Cmd
// on macOS) creates one from the selection, Ctrl+Shift adds the selection to
// one, Shift adds a group to the selection, Alt jumps to it. An actor belongs
// to one group at a time, like the original. No DOM here, so it is tested headless.

export const DOUBLE_TAP_MS = 400;

export class ControlGroups {
  constructor({ doubleTapMs = DOUBLE_TAP_MS } = {}) {
    this.doubleTapMs = doubleTapMs;
    this.groups = new Map(); // key -> ids
    this.lastTap = { key: null, time: -Infinity };
  }

  /** Store `ids` as group `key`, taking them out of any other group. Empty ids clear the group. */
  assign(key, ids) {
    const set = new Set(ids);
    for (const [k, members] of this.groups) {
      if (k === key) continue;
      const rest = members.filter((id) => !set.has(id));
      if (rest.length) this.groups.set(k, rest);
      else this.groups.delete(k);
    }
    if (set.size) this.groups.set(key, [...set]);
    else this.groups.delete(key);
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
    for (const [k, members] of [...this.groups]) {
      const rest = members.filter((id) => !set.has(id));
      if (rest.length) this.groups.set(k, rest);
      else this.groups.delete(k);
    }
  }

  /** Members of a group still accepted by `alive` (dead ones are dropped for good). */
  members(key, alive = (ids) => ids) {
    const ids = this.groups.get(key);
    if (!ids) return [];
    const left = alive(ids);
    if (left.length) this.groups.set(key, left);
    else this.groups.delete(key);
    return left;
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
