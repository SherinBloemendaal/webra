// Control groups (Red Alert "teams"): Ctrl+1..9,0 (Cmd on macOS) stores the
// selection, the number selects it again, a quick second press centres the
// camera on it, Shift+number adds it to the selection. A unit belongs to one
// group at a time, like the original. No DOM here, so it is tested headless.

export const DOUBLE_TAP_MS = 400;

/** Group key ('0'..'9') for a keydown on the digit row, or null. The numpad drives the sidebar. */
export function groupKeyFromEvent(e) {
  const m = /^Digit([0-9])$/.exec(e.code ?? '');
  return m ? m[1] : null;
}

/** What a digit keydown does: 'assign', 'add', 'select' or null (other modifiers). */
export function groupCommand(e) {
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return 'assign';
  if (e.shiftKey) return 'add';
  return 'select';
}

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
