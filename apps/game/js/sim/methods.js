// Which wasm `Game` methods the main thread may use, and how each one crosses
// the boundary to a simulation that runs in a Web Worker (js/sim/host.js).
// docs/contracts.md (section 8) has the reasoning per method.
//
// - ORDERS change the game. They are sent to the worker in order and applied
//   before its next step (in lockstep they only queue an order anyway).
// - UI_STATE (selection, hover, control groups, placement) changes what the worker draws: sent like
//   orders, and mirrored on the main thread.
// - QUERIES only read. On the main thread they answer synchronously from the
//   last values the worker sent (each call registers the query, the worker
//   answers it with its next frame), with DEFAULTS before the first answer.
//   `ask.<method>(...)` returns a promise of a fresh answer instead: after
//   everything sent before it, for code that acts on the answer.
// - Everything else (tick, apply_frame, take_orders, build_render, fog,
//   terrain, heat shimmer, the sky, audio events, hashes, snapshots) stays
//   inside js/sim/core.js; the sky at the start is static (`weather_json`).

export const NONE = 0xffffffff;

/** Methods that give orders (lockstep: queued in the engine's outbox). */
export const ORDERS = Object.freeze([
  'order_smart',
  'order_move',
  'order_attack',
  'order_stop',
  'order_attack_ground',
  'order_guard',
  'order_scatter',
  'order_waypoint',
  'order_land',
  'order_return_to_base',
  'order_lay_mines',
  'order_teleport',
  'set_stance',
  'sell',
  // Sidebar buttons (engine/src/repair.rs, beacons.rs).
  'repair_building',
  // WebRA bulk repair: the Repair button with structures selected, a box in repair mode.
  'repair_buildings',
  'repair_units',
  // WebRA bulk sell: a box in sell mode.
  'sell_buildings',
  'power_down',
  'place_beacon',
  // The game menu's Surrender (engine/src/gamerules.rs).
  'surrender',
  'deploy',
  'activate_power',
  'set_rally',
  'start_production',
  'cancel_production',
  'pause_production',
  'place_building',
  'dev_flag',
  'dev_give_cash',
  'dev_kill',
  'dev_experience',
]);

/** Local view state: what is selected and hovered, the control groups and the structure being placed (drawn by the engine). */
export const UI_STATE = Object.freeze(['set_selection', 'set_hover', 'set_control_groups', 'set_placing']);

const EMPTY_U32 = () => new Uint32Array(0);
const EMPTY_I32 = () => new Int32Array(0);
const EMPTY_F32 = () => new Float32Array(0);
/** `repair_*_json` with nothing to repair. */
const REPAIR_GROUPS_NONE = JSON.stringify({ buildings: [], combat: [], harvesters: [], other: [], noFacility: [] });

/**
 * Read-only queries the UI makes, with the value a query returns before the
 * worker answered it the first time (the same value the engine returns for
 * "nothing there").
 */
export const QUERY_DEFAULTS = Object.freeze({
  pick: () => NONE,
  // The battlefield tooltip (js/worldtooltip.js): JSON, 'null' for none.
  world_tooltip: () => 'null',
  select_box: EMPTY_U32,
  select_at: () => NONE,
  select_all: EMPTY_U32,
  select_by_class: EMPTY_U32,
  units_center: EMPTY_F32,
  actor_json: () => 'null',
  cursor_action: () => 0,
  command_state: () => JSON.stringify({ units: 0, armed: 0, attackGround: 0, guard: 0, scatter: 0, queued: 0, stances: {} }),
  can_guard: () => false,
  can_attack_ground: () => false,
  // Force attack on an actor: whether a selected weapon can hit it (js/commandbar.js).
  can_attack_actor: () => false,
  // Whether a plain move passes visible enemies (the attack-move tip, js/hints.js).
  move_hint: () => false,
  sell_value: () => 0,
  // Sidebar modes and the hotkeys that cycle through actors (js/input.js).
  repair_cursor: () => 0,
  repair_unit_target: EMPTY_F32,
  // Bulk repair and sell (js/input.js): what the selection or a box dragged in repair mode
  // repairs, by category (JSON), and the structures a box in sell mode sells.
  repair_selection_json: () => REPAIR_GROUPS_NONE,
  repair_box_json: () => REPAIR_GROUPS_NONE,
  sell_box: EMPTY_U32,
  can_power_down: () => false,
  base_actors: EMPTY_U32,
  harvesters: EMPTY_U32,
  production_buildings: EMPTY_U32,
  queue_producer: () => NONE,
  army_counts: EMPTY_U32,
  deploy_state: () => 0,
  ability_deploy_state: () => 0,
  has_minelayer: () => false,
  teleport_valid: () => false,
  placement_preview: EMPTY_I32,
  debug_cells: EMPTY_I32,
  debug_flow: EMPTY_I32,
  debug_actors: () => '[]',
  debug_stats: () => 'null',
  // Asked every UI tick; null until the first answer (the caller waits for it).
  player_json: () => null,
  observer_stats: () => null,
  // The top-left support power timers a player sees (js/powertimers.js): none until the first answer.
  power_timers_json: () => '[]',
  // The observer's production and support power icons, per player (js/observer-icons.js).
  observer_production: () => null,
  // The end-game statistics (asked with `ask.observer_report()` when the statistics screen opens or refreshes).
  observer_report: () => null,
  radar_state: () => 0,
  minimap_blips: EMPTY_I32,
  actor_count: () => 0,
  // Composite queries (COMPOSITES below): one answer instead of one query per selected actor.
  deploy_summary: () => 0,
  deploy_targets: () => ({ teleport: [], deploy: [] }),
});

/**
 * Queries made of several Game calls, run where the game is (worker or main
 * thread), so a large selection costs one message, not one per actor.
 */
export const COMPOSITES = Object.freeze({
  /** 0: nothing selected can deploy, 1: something can deploy now (or pick a teleport target), 2: blocked. */
  deploy_summary(game, player, ids) {
    let best = 0;
    for (const id of ids) {
      const st = game.deploy_state(player, id);
      const ab = game.ability_deploy_state(player, id);
      // 3: a production structure the deploy command makes primary (engine primary.rs).
      if (st === 1 || st === 3 || ab === 1 || ab === 3) return 1;
      if (st === 2 || ab === 2) best = 2;
    }
    return best;
  },
  /**
   * What a deploy command does with the selection: chrono tanks pick a
   * teleport target first (`teleport`); otherwise MCVs, Construction Yards,
   * transports and ability units deploy (`deploy`).
   */
  deploy_targets(game, player, ids) {
    const teleport = [];
    for (const id of ids) if (game.ability_deploy_state(player, id) === 3) teleport.push(id);
    if (teleport.length) return { teleport, deploy: [] };
    const deploy = [];
    for (const id of ids) if (game.deploy_state(player, id) !== 0 || game.ability_deploy_state(player, id) === 1) deploy.push(id);
    return { teleport, deploy };
  },
});

export const QUERIES = Object.freeze(Object.keys(QUERY_DEFAULTS));

/**
 * Queries whose answer may come from the same query with other arguments
 * while the right one is on its way: the hover position and the view
 * rectangle change every frame, and one frame old is what the screen shows
 * anyway. The others (ids) wait for their own answer.
 */
export const FOLLOW_LATEST = Object.freeze(
  new Set([
    'pick',
    'world_tooltip',
    'cursor_action',
    'can_guard',
    'can_attack_ground',
    'can_attack_actor',
    'teleport_valid',
    'placement_preview',
    'debug_cells',
    'debug_flow',
    'debug_actors',
    'command_state',
    // The sidebar mode cursors ask about the actor under the mouse.
    'repair_cursor',
    'can_power_down',
    // The repair and sell modes' boxes follow the mouse.
    'repair_box_json',
    'sell_box',
  ]),
);

/** Facts that never change during a game: read once when it starts. */
export const STATIC = Object.freeze(['rules_json', 'map_width', 'map_height', 'cheats_enabled', 'player_count', 'weather_json']);

const ORDER_SET = new Set(ORDERS);
const UI_SET = new Set(UI_STATE);
const QUERY_SET = new Set(QUERIES);

export const isOrder = (m) => ORDER_SET.has(m);
export const isUiState = (m) => UI_SET.has(m);
export const isQuery = (m) => QUERY_SET.has(m);

/** Actor table layout (engine/src/actor_table.rs). */
export const TABLE_STRIDE = 2;
export const TABLE_BUILDING = 1;
export const TABLE_PRODUCER = 2;
export const TABLE_IN_WORLD = 4;
export const TABLE_UNIT = 8;
/** Low 22 bits of an actor id: its slot in the table (engine/src/world.rs IDX_BITS). */
export const ID_SLOT_MASK = 0x3fffff;

/**
 * `{ id, type, owner, building, producer, inWorld, unit }` for an actor id
 * from an actor table (`Game.actor_table()`), or null when it is gone. The
 * subset of `actor_json` the UI needs for selection, orders and voices.
 */
export function tableInfo(table, actorIds, id) {
  if (!table || id === NONE || id === undefined || id === null) return null;
  const slot = (id & ID_SLOT_MASK) * TABLE_STRIDE;
  if (slot + 1 >= table.length || table[slot] !== id >>> 0) return null;
  const packed = table[slot + 1];
  const flags = (packed >>> 8) & 0xff;
  return {
    id: id >>> 0,
    type: actorIds[packed >>> 16] ?? null,
    owner: packed & 0xff,
    building: (flags & TABLE_BUILDING) !== 0,
    producer: (flags & TABLE_PRODUCER) !== 0,
    inWorld: (flags & TABLE_IN_WORLD) !== 0,
    unit: (flags & TABLE_UNIT) !== 0,
  };
}

/**
 * `actor_info` of a game handle (js/sim/proxy.js), or the same fields from
 * `actor_json` for a plain Game (tests, tools).
 */
export function actorInfo(game, id) {
  if (typeof game.actor_info === 'function') return game.actor_info(id);
  if (id === NONE || id === undefined || id === null) return null;
  const a = JSON.parse(game.actor_json(id));
  if (!a) return null;
  const inWorld = a.carrier === undefined || a.carrier === NONE;
  return { id, type: a.type, owner: a.owner, building: !!a.building, producer: !!a.producer, inWorld, unit: !a.building };
}

/** A query by name, also a composite one for a plain Game. */
export function queryOf(game, method, ...args) {
  if (typeof game[method] === 'function') return game[method](...args);
  const composite = COMPOSITES[method];
  if (!composite) throw new Error(`unknown query ${method}`);
  return composite(game, ...args);
}

/**
 * The asynchronous queries of a game handle (`game.ask`), or immediately
 * resolved ones for a plain Game (tests, tools).
 */
export function askOf(game) {
  if (game.ask) return game.ask;
  return new Proxy(
    {},
    {
      get: (_, method) => (...args) => {
        try {
          return Promise.resolve(queryOf(game, method, ...args));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
  );
}

/** A stable cache key for a query: method plus arguments (id lists hashed). */
export function queryKey(method, args) {
  let key = method;
  for (const a of args) {
    if (ArrayBuffer.isView(a)) key += `|${hashIds(a)}`;
    else if (Array.isArray(a)) key += `|${hashIds(a)}`;
    else key += `|${a}`;
  }
  return key;
}

/** FNV-1a over an id list, with its length: cheap keys for large selections. */
export function hashIds(ids) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ids.length; i++) {
    h ^= ids[i] >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${ids.length}:${h.toString(36)}`;
}
