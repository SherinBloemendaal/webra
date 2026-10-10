// The map editor's actor palette: every actor of the rules in one group,
// by OpenRA map editor category (rules_json world.category) and kind. Pure
// module.

/**
 * The palette by OpenRA map editor category (rules_json world.category) and
 * kind: every actor of the rules has a place (proxies and bridge huts are
 * placed by the game itself).
 */
const WORLD_GROUPS = [
  { name: 'Tech buildings', category: 'Tech building' },
  { name: 'Civilian buildings', category: 'Civilian building' },
  { name: 'Civilians', category: 'Civilian infantry' },
  { name: 'Trees', category: 'Tree' },
  { name: 'Decorations', category: 'Decoration' },
  { name: 'Ore and gem mines', category: 'Resource spawn' },
];
const isWorld = (a) => !!a.world?.bridge || !!a.world?.bridgeHut || WORLD_GROUPS.some((g) => g.category === a.world?.category);
const isWall = (a) => a.world?.category === 'Wall';
export const PALETTE_GROUPS = [
  { name: 'Structures', test: (a) => a.kind === 'building' && a.queue === 0 && !isWorld(a) && !isWall(a) && !a.name.startsWith('Fake') },
  { name: 'Defenses', test: (a) => a.kind === 'building' && a.queue === 1 && !isWall(a) && !a.name.startsWith('Fake') && !isWorld(a) },
  { name: 'Walls', test: (a) => isWall(a) },
  { name: 'Fakes', test: (a) => a.kind === 'building' && a.name.startsWith('Fake') && !isWorld(a) },
  { name: 'Other structures', test: (a) => a.kind === 'building' && a.queue > 1 && !isWorld(a) && !isWall(a) && !a.name.startsWith('Fake') },
  { name: 'Infantry', test: (a) => a.kind === 'infantry' && !isWorld(a) },
  { name: 'Vehicles', test: (a) => a.kind === 'vehicle' && !isWorld(a) },
  { name: 'Ships', test: (a) => a.kind === 'ship' },
  { name: 'Aircraft', test: (a) => a.kind === 'aircraft' },
  { name: 'Mines', test: (a) => a.kind === 'mine' },
  // OpenRA's crates and husks (engine/src/crates.rs, husks.rs), as in its editor.
  { name: 'Crates', test: (a) => a.kind === 'crate' },
  { name: 'Husks', test: (a) => a.kind === 'husk' },
  ...WORLD_GROUPS.map((g) => ({ name: g.name, test: (a) => a.world?.category === g.category && !a.world?.bridge })),
  // Bridges bring their template's terrain when placed (js/edits.js stampBridge).
  { name: 'Bridges', test: (a) => !!a.world?.bridge },
];

/** Actors the game places itself: proxies (engine infantry.rs) and bridge huts (with their bridge). */
export const placedByTheGame = (a) => a.kind === 'proxy' || !!a.world?.bridgeHut;
