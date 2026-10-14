// The map editor's tools and commands with their default keys. They go to
// the game's hotkey registry (js/hotkeys.js) under "editor.*" names, so the
// player can rebind them (Keys dialog) and the bindings are kept with the
// game's (settings `hotkeys`, synced with the account); tooltips and the
// help show the keys in use.

/** Tools, in toolbar order. `paint` tools paint the chosen layer (terrain, ore or gems). */
export const TOOLS = [
  { id: 'select', key: 'V', icon: 'select', label: 'Select', hint: 'Click or drag a box to select actors; drag them to move. A spawn drags along with its mirror images.' },
  { id: 'region', key: 'M', icon: 'region', label: 'Region', hint: 'Drag to select cells. Copy, cut, paste, crop, save as a stamp; drag inside the region to move it.' },
  { id: 'brush', key: 'B', icon: 'brush', label: 'Brush', hint: 'Paint with the round brush. Right drag paints clear ground (or removes ore or gems).', paint: true },
  { id: 'line', key: 'L', icon: 'line', label: 'Line', hint: 'Drag a line in the brush size: roads, rivers, cliffs. Right drag clears.', paint: true },
  { id: 'rect', key: 'R', icon: 'rect', label: 'Rectangle', hint: 'Drag a rectangle, filled or its border. Right drag clears.', paint: true },
  { id: 'ellipse', key: 'U', icon: 'ellipse', label: 'Ellipse', hint: 'Drag an ellipse, filled or its ring: lakes, islands, plateaus. Right drag clears.', paint: true },
  { id: 'fill', key: 'F', icon: 'fill', label: 'Fill', hint: 'Fill the connected area of one terrain type.', paint: true },
  { id: 'eraser', key: 'E', icon: 'eraser', label: 'Eraser', hint: 'Back to clear ground: removes ore, gems and actors.' },
  { id: 'eyedropper', key: 'I', icon: 'eyedropper', label: 'Pick', hint: 'Click to pick the terrain, ore, gems or actor under the cursor.' },
  { id: 'spawn', key: 'S', icon: 'spawn', label: 'Spawns', hint: 'Click to add a start (with its mirror images), drag to move, right click to remove.' },
  { id: 'actor', key: 'A', icon: 'actor', label: 'Actor', hint: 'Place the actor picked in the Actors tab. Right click deletes. , and . turn it.' },
  { id: 'paste', key: null, icon: 'paste', label: 'Paste', hint: 'Click to paste the clipboard or stamp (with its mirror images). T turns it, H and Shift+H mirror it.' },
];

/** What paint tools paint. */
export const PAINT_LAYERS = [
  { value: 'terrain', label: 'Terrain' },
  { value: 'ore', label: 'Ore' },
  { value: 'gems', label: 'Gems' },
];

/**
 * Commands with their default keys (the hotkey registry's combo syntax).
 * `group` is the section in the Keys dialog.
 */
export const COMMANDS = [
  // File
  { name: 'new', label: 'New map', keys: ['Ctrl+Alt+N'], group: 'File' },
  { name: 'open', label: 'Open a map file or .oramap', keys: ['Ctrl+O'], group: 'File' },
  { name: 'save', label: 'Download the map file', keys: ['Ctrl+S'], group: 'File' },
  { name: 'png', label: 'Export a PNG picture', keys: [], group: 'File' },
  { name: 'test', label: 'Test play', keys: ['Ctrl+Enter'], group: 'File' },
  { name: 'publish', label: 'Publish', keys: [], group: 'File' },
  // Edit
  { name: 'undo', label: 'Undo', keys: ['Ctrl+Z'], group: 'Edit' },
  { name: 'redo', label: 'Redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], group: 'Edit' },
  { name: 'copy', label: 'Copy the region', keys: ['Ctrl+C'], group: 'Edit' },
  { name: 'cut', label: 'Cut the region', keys: ['Ctrl+X'], group: 'Edit' },
  { name: 'paste', label: 'Paste', keys: ['Ctrl+V'], group: 'Edit' },
  { name: 'delete', label: 'Delete the selection or clear the region', keys: ['Delete', 'Backspace'], group: 'Edit' },
  { name: 'selectAll', label: 'Select all actors', keys: ['Ctrl+A'], group: 'Edit' },
  { name: 'turnClip', label: 'Turn the clipboard a quarter', keys: ['T'], group: 'Edit' },
  { name: 'mirrorClipX', label: 'Mirror the clipboard left / right', keys: ['H'], group: 'Edit' },
  { name: 'mirrorClipY', label: 'Mirror the clipboard top / bottom', keys: ['Shift+H'], group: 'Edit' },
  { name: 'rotateLeft', label: 'Turn the actor left', keys: [','], group: 'Edit' },
  { name: 'rotateRight', label: 'Turn the actor right', keys: ['.'], group: 'Edit' },
  // Brush
  { name: 'sizeDown', label: 'Smaller brush', keys: ['['], group: 'Brush' },
  { name: 'sizeUp', label: 'Larger brush', keys: [']'], group: 'Brush' },
  { name: 'densityDown', label: 'Less ore or gems', keys: ['-'], group: 'Brush' },
  { name: 'densityUp', label: 'More ore or gems', keys: ['='], group: 'Brush' },
  { name: 'paintTerrain', label: 'Paint terrain', keys: [], group: 'Brush' },
  { name: 'paintOre', label: 'Paint ore', keys: ['O'], group: 'Brush' },
  { name: 'paintGems', label: 'Paint gems', keys: ['C'], group: 'Brush' },
  { name: 'symmetry', label: 'Next symmetry', keys: ['Y'], group: 'Brush' },
  // View
  { name: 'zoomIn', label: 'Zoom in', keys: ['PageUp'], group: 'View' },
  { name: 'zoomOut', label: 'Zoom out', keys: ['PageDown'], group: 'View' },
  { name: 'fit', label: 'Show the whole map', keys: ['Home'], group: 'View' },
  { name: 'grid', label: 'Grid', keys: ['G'], group: 'View' },
  { name: 'layerPassability', label: 'Passability layer', keys: [], group: 'View' },
  { name: 'layerZones', label: 'Spawn zones layer', keys: [], group: 'View' },
  { name: 'help', label: 'Shortcuts and help', keys: ['Shift+/'], group: 'View' },
];

/** Terrain keys 1 to 0, in material order (editor.js MATERIALS). */
export const MATERIAL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** The hotkey registry name of a tool or command. */
export const actionName = (id) => `editor.${id}`;

/** The help's introduction (the Shortcuts dialog): what the mouse and touch do beyond the tools. */
export const HELP_TEXT =
  'Tools paint with symmetry: every edit also lands at its mirror images. Right drag undoes what a tool does (paints clear ground, removes ore). ' +
  'Middle drag, Space and drag, two fingers or the arrow keys move the map; the wheel and pinching zoom. ' +
  'On the minimap any mouse button (left, right or middle) moves the view to that spot and dragging keeps moving it; the wheel zooms there.';
