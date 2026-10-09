// The debug menu's local view overlays (js/debug.js), apart so the settings
// registry (js/registry.js) can list them without loading the debug menu.

/** Local view overlays, in menu order. */
export const VIEWS = [
  { key: 'cells', label: 'Cell grid and occupancy', title: 'Grid, blocked cells, water, structure footprints and cells with units.' },
  { key: 'footprints', label: 'Footprints and radii', title: 'Structure footprints and unit hit radii.' },
  { key: 'flow', label: 'Pathing', title: 'Flow field of the first selected moving unit, and the goals of own units.' },
  { key: 'combat', label: 'Combat geometry', title: 'Weapon ranges and the current target of each actor.' },
  { key: 'tags', label: 'Actor ids and tags', title: 'Actor id, type, owner and activity.' },
  { key: 'health', label: 'Health numbers', title: 'Hit points of every visible actor.' },
  { key: 'stats', label: 'Performance stats', title: 'FPS, frame and simulation time, actor counts, pathing cache.' },
  { key: 'graph', label: 'Frame graph', title: 'Frame, render and simulation time of the last frames.' },
];
