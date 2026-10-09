// Losing access to the game files mid-session. While the site requires an
// account for the game, the Worker serves /play only to accounts that may
// play (docs/security.md, "The play gate"). The game loads some modules and
// its simulation worker later (online play, saves and replays, every new
// game): when the sign-in ended meanwhile (signed out elsewhere, session
// revoked, account banned), those requests get 401 or 403. The game asks
// /play/ what is wrong and offers to sign in again instead of breaking; what
// already runs in memory keeps running.

/** The game's own page: the Worker answers a HEAD request for it with the gate's verdict. */
export const PROBE_URL = new URL('../../', import.meta.url);

/**
 * Whether this browser may load the game files now: 'ok', 'signin' (401, no
 * valid sign-in), 'forbidden' (403: pending, banned, banned address),
 * 'offline' (no answer) or 'error' (anything else).
 */
export async function probePlayAccess({ fetchImpl = (...a) => globalThis.fetch(...a), url = PROBE_URL } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { accept: 'application/json' } });
  } catch {
    return 'offline';
  }
  if (res.status === 401) return 'signin';
  if (res.status === 403) return 'forbidden';
  if (res.ok || res.status === 304) return 'ok';
  return 'error';
}

/** Thrown by PlayAccess.load when the game files were refused (`state` is 'signin' or 'forbidden'). */
export class PlayAccessLost extends Error {
  constructor(state, cause) {
    super(state === 'signin' ? 'Your sign-in has ended. Sign in again to load the rest of the game.' : 'Your account cannot load the game right now.', { cause });
    this.name = 'PlayAccessLost';
    this.state = state;
  }
}

export class PlayAccess {
  /**
   * @param {{ onLost: (state: 'signin' | 'forbidden') => unknown, probe?: () => Promise<string> }} o
   *   onLost: show the sign-in prompt (called once while it is open)
   */
  constructor({ onLost, probe = () => probePlayAccess() }) {
    this.onLost = onLost;
    this.probe = probe;
    this.prompt = null;
  }

  /**
   * Run `load` (a lazy import of game modules, a worker start, a fetch of a
   * game file). When it fails, ask the gate why: refused means the prompt
   * and PlayAccessLost; allowed again (signed in meanwhile) means one more
   * try; anything else is the original error.
   * @template T
   * @param {() => Promise<T>} load
   * @returns {Promise<T>}
   */
  async load(load) {
    try {
      return await load();
    } catch (err) {
      const state = await this.probe();
      if (state === 'signin' || state === 'forbidden') {
        this.lost(state);
        throw new PlayAccessLost(state, err);
      }
      if (state === 'ok') return load();
      throw err;
    }
  }

  /** Show the prompt for a refusal, unless one is open already. */
  lost(state) {
    if (this.prompt) return this.prompt;
    this.prompt = Promise.resolve()
      .then(() => this.onLost(state))
      .catch((err) => console.warn('play access prompt failed:', err))
      .finally(() => {
        this.prompt = null;
      });
    return this.prompt;
  }
}
