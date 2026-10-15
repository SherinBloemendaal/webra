// Campaign progress: which missions the player won, and which ones are open.
//
// The missions come from apps/game/missions/index.json (tools/gen_missions.py,
// OpenRA's missions.yaml). Progress is a setting of the registry
// (extra.campaignProgress, synced with the account): mission id -> the
// difficulty it was won on ('' for a mission without one).
//
// What is open: the Allied, Soviet and ant campaigns are numbered chapters
// ("03a: Dead End", "03b: Dead End"); the first chapter is open, and every
// later one opens when a mission of the chapter before it is won (any of its
// variants, as in the original game, which let the player pick one). The
// Counterstrike, Aftermath and OpenRA missions are separate operations and
// open from the start, as they were in the original expansions.
//
// No DOM: the campaign screen (js/campaign/menu.js) and the tests use it.

import { defaultRegistry } from '../registry.js';

/** The chapter number of a mission title ("03a: Dead End" -> 3), or null for an unnumbered one. */
export function chapterOf(title) {
  const m = /^(\d+)[a-z]?:/i.exec(String(title ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Per mission of `campaign` (an index.json campaign), in its order:
 * `{ mission, chapter, won, open }`, `won` being the difficulty it was won on
 * ('' without one) or null.
 * @param {{ missions: Array<{ id: string, title: string }> }} campaign
 * @param {Record<string, string>} progress
 */
export function campaignStates(campaign, progress) {
  const missions = campaign.missions.map((mission) => ({
    mission,
    chapter: chapterOf(mission.title),
    won: typeof progress[mission.id] === 'string' ? progress[mission.id] : null,
    open: true,
  }));
  if (!missions.length || missions.some((m) => m.chapter === null)) return missions;
  const chapters = [...new Set(missions.map((m) => m.chapter))].sort((a, b) => a - b);
  const wonIn = new Set(missions.filter((m) => m.won !== null).map((m) => m.chapter));
  for (const m of missions) {
    const k = chapters.indexOf(m.chapter);
    m.open = k === 0 || wonIn.has(chapters[k - 1]);
  }
  return missions;
}

/**
 * The mission to offer after `id` was won: the first open, not yet won
 * mission of a later chapter of its campaign (or the next one in the list
 * for unnumbered campaigns), else null.
 */
export function nextMission(index, id, progress) {
  for (const campaign of index.campaigns) {
    const states = campaignStates(campaign, progress);
    const at = states.findIndex((s) => s.mission.id === id);
    if (at < 0) continue;
    const here = states[at];
    const later = states.slice(at + 1).filter((s) => s.open && (here.chapter === null || s.chapter > here.chapter));
    return (later.find((s) => s.won === null) ?? later[0])?.mission ?? null;
  }
  return null;
}

/**
 * The mission the campaign screen marks NEXT in `campaign`: the one
 * nextMission() offers after the furthest won mission of the list, else
 * (nothing won yet, or nothing open after it) the first open mission not won
 * yet; null when every open mission is won.
 */
export function campaignNext(campaign, progress) {
  const states = campaignStates(campaign, progress);
  const lastWon = states.findLastIndex((s) => s.won !== null);
  if (lastWon >= 0) {
    const after = nextMission({ campaigns: [campaign] }, states[lastWon].mission.id, progress);
    if (after && typeof progress[after.id] !== 'string') return after;
  }
  return states.find((s) => s.open && s.won === null)?.mission ?? null;
}

/** "won", "next", "open" or "locked": how the campaign screen shows a mission of campaignStates(). */
export function missionStatus(state, next) {
  if (state.won !== null) return 'won';
  if (!state.open) return 'locked';
  return next && state.mission.id === next.id ? 'next' : 'open';
}

/** The campaign entry of mission `id` in `index`, with its campaign: `{ campaign, mission }` or null. */
export function findMission(index, id) {
  for (const campaign of index.campaigns) {
    const mission = campaign.missions.find((m) => m.id === id);
    if (mission) return { campaign, mission };
  }
  return null;
}

/** The progress setting of a registry (js/registry.js). */
export class CampaignProgress {
  constructor(registry = defaultRegistry()) {
    this.registry = registry;
  }

  /** mission id -> difficulty won on ('' without one). */
  get() {
    const v = this.registry.get('extra', 'campaignProgress');
    const out = {};
    if (v && typeof v === 'object') for (const [k, d] of Object.entries(v)) if (typeof d === 'string') out[k] = d;
    return out;
  }

  /** Mission `id` was won on `difficulty` (null: the mission has none). */
  won(id, difficulty) {
    const progress = this.get();
    progress[id] = difficulty ?? '';
    this.registry.set('extra', 'campaignProgress', progress);
  }

  subscribe(fn) {
    return this.registry.subscribe('extra', () => fn(this.get()));
  }
}
