// The game screen's own hotkeys (js/hotkeys.js): production tabs and slots,
// support powers, pause, status bars, mute, screenshot, quick save, music,
// hiding the interface, the observer views and statistics, replay speed and
// WebRA's extras (debug menu, unit paths, fullscreen, mouse capture, the
// sidebar's numpad).
// js/input.js registers the orders, sidebar modes, selection, camera and
// control groups; js/commandbar.js the unit commands and stances; js/online.js
// the chat keys.
//
// GAME_KEYS is the table (testable without a DOM); main.js supplies the
// handlers. An entry is registered when its handler exists and its contexts
// (OpenRA's player and spectator contexts) fit the game: spectators and
// replays get the spectator hotkeys, players the player ones. Their defaults
// are OpenRA's (js/openra-hotkeys.js) unless `keys` says otherwise.

import { OPENRA_HOTKEYS } from './openra-hotkeys.js';
import { releaseMouseKey } from './hotkeys.js';

const PRODUCTION_TABS = [
  ['productionTabBuildings', 'ProductionTypeBuilding'],
  ['productionTabDefense', 'ProductionTypeDefense'],
  ['productionTabInfantry', 'ProductionTypeInfantry'],
  ['productionTabVehicles', 'ProductionTypeVehicle'],
  ['productionTabAircraft', 'ProductionTypeAircraft'],
  ['productionTabNaval', 'ProductionTypeNaval'],
];

const two = (n) => String(n).padStart(2, '0');

/**
 * Hotkey table: name (the action, and the handler's name in `handlers`),
 * `openra` (the OpenRA hotkey: defaults, description, section, contexts) or
 * `keys` + `label` + `group` + `contexts` for WebRA's own, `arg` handed to
 * the handler, and registry options (`modifiers`, `inControls`, `repeat`).
 */
export const GAME_KEYS = Object.freeze([
  // Game commands.
  { name: 'pause', openra: 'Pause' },
  { name: 'cycleStatusBars', openra: 'CycleStatusBars' },
  { name: 'toggleMute', openra: 'ToggleMute' },
  { name: 'togglePlayerStanceColor', openra: 'TogglePlayerStanceColor' },
  { name: 'takeScreenshot', openra: 'TakeScreenshot' },
  { name: 'quickSave', openra: 'QuickSave' },
  // WebRA's own: the game menu (Esc always opens it too), debug menu, unit paths, fullscreen.
  { name: 'menu', keys: [], label: 'Game menu (Esc also opens it)', group: 'Game Commands', contexts: ['player', 'spectator'] },
  { name: 'debugMenu', keys: ['`'], label: 'Debug menu', group: 'Game Commands', contexts: ['player', 'spectator'] },
  // The debug menu's performance capture (js/perfcapture.js): start, or stop and save. Alt+P is free in OpenRA's set.
  { name: 'recordPerformance', keys: ['Alt+P'], label: 'Record performance (again: stop and save)', group: 'Game Commands', contexts: ['player', 'spectator'] },
  // OpenRA has no default key for its path lines; L is free in its set.
  { name: 'showUnitPaths', keys: ['L'], label: 'Show unit paths', group: 'Game Commands', contexts: ['player', 'spectator'] },
  { name: 'fullscreen', keys: ['Alt+Enter'], label: 'Fullscreen', group: 'Game Commands', contexts: ['player', 'spectator', 'menu'] },
  // Mouse capture (js/mouselock.js): OpenRA has no key for it. Option+E on
  // macOS like cloud gaming services, Alt+Shift+E on Windows and Linux
  // (RELEASE_MOUSE_KEYS in js/hotkeys.js: Alt+E is a browser menu key there):
  // while captured it releases the mouse and the game plays on (a click into
  // the game captures it again); while released it captures. On macOS
  // OpenRA's Alt+E (jump to bookmark 3) has no default key for it
  // (WEBRA_SUBSTITUTES). main.js registers it only where the browser has
  // Pointer Lock.
  { name: 'toggleMouseCapture', keys: [releaseMouseKey()], label: 'Release or capture the mouse', group: 'Game Commands', contexts: ['player', 'spectator'] },
  // Viewport: hide the interface (OpenRA DisableUserInterface, DisableAllUserInterface).
  { name: 'disableUserInterface', openra: 'DisableUserInterface' },
  { name: 'disableAllUserInterface', openra: 'DisableAllUserInterface' },
  // Production: tabs (E R T Y U I), the tab's facility (Tab), the next
  // facility (Shift+Tab: the browser keeps OpenRA's Ctrl+Tab) and the slots
  // (F1..F12, Ctrl+F1..F12; Shift builds 5).
  ...PRODUCTION_TABS.map(([name, openra], q) => ({ name, openra, handler: 'productionTab', arg: q })),
  // Tab moves focus between buttons while one has focus.
  { name: 'selectProductionBuilding', openra: 'SelectProductionBuilding', inControls: false },
  { name: 'cycleProductionBuildings', openra: 'CycleProductionBuildings', inControls: false },
  ...Array.from({ length: 24 }, (_, i) => ({ name: `production${two(i + 1)}`, openra: `Production${two(i + 1)}`, handler: 'productionSlot', arg: i + 1, modifiers: ['Shift'] })),
  // WebRA's own: cycling the tabs, and the numpad (1..9 build, Shift: 5,
  // Ctrl: cancel one; + and 0 next tab, - previous tab, . cancels placement).
  { name: 'nextTab', keys: [], label: 'Next production tab', group: 'Production Commands', contexts: ['player'], handler: 'cycleTab', arg: 1, inControls: false },
  { name: 'previousTab', keys: [], label: 'Previous production tab', group: 'Production Commands', contexts: ['player'], handler: 'cycleTab', arg: -1, inControls: false },
  ...Array.from({ length: 9 }, (_, i) => ({
    name: `numpadSlot${i + 1}`,
    keys: [`Numpad${i + 1}`],
    label: `Numpad slot ${i + 1} (Shift: 5, Ctrl: cancel one)`,
    group: 'Production Commands',
    contexts: ['player'],
    handler: 'numpadSlot',
    arg: i + 1,
    modifiers: ['Shift', 'Ctrl'],
  })),
  { name: 'numpadNextTab', keys: ['NumpadAdd', 'Numpad0'], label: 'Numpad: next production tab', group: 'Production Commands', contexts: ['player'], handler: 'cycleTab', arg: 1 },
  { name: 'numpadPreviousTab', keys: ['NumpadSubtract'], label: 'Numpad: previous production tab', group: 'Production Commands', contexts: ['player'], handler: 'cycleTab', arg: -1 },
  { name: 'cancelPlacement', keys: ['NumpadDecimal'], label: 'Cancel building placement', group: 'Production Commands', contexts: ['player'] },
  // Support powers: the n-th power of the power bar (no default keys in OpenRA).
  ...Array.from({ length: 6 }, (_, i) => ({ name: `supportPower${two(i + 1)}`, openra: `SupportPower${two(i + 1)}`, handler: 'supportPower', arg: i })),
  // Music.
  { name: 'stopMusic', openra: 'StopMusic' },
  { name: 'pauseMusic', openra: 'PauseMusic' },
  { name: 'prevMusic', openra: 'PrevMusic' },
  { name: 'nextMusic', openra: 'NextMusic' },
  // Observer and replay: the views, the statistics panels and replay speed.
  { name: 'observerCombinedView', openra: 'ObserverCombinedView' },
  { name: 'observerWorldView', openra: 'ObserverWorldView' },
  ...['None', 'Basic', 'Economy', 'Production', 'SupportPowers', 'Combat', 'Army', 'Graph', 'ArmyGraph'].map((panel) => ({
    name: `statistics${panel}`,
    openra: `Statistics${panel}`,
    handler: 'statistics',
    arg: panel.charAt(0).toLowerCase() + panel.slice(1),
  })),
  ...[
    ['Slow', 0.5],
    ['Regular', 1],
    ['Fast', 2],
    ['Max', 'max'],
  ].map(([s, speed]) => ({ name: `replaySpeed${s}`, openra: `ReplaySpeed${s}`, handler: 'replaySpeed', arg: speed })),
]);

/** The contexts an entry belongs to (OpenRA's, or its own). */
export function keyContexts(entry) {
  return entry.contexts ?? OPENRA_HOTKEYS[entry.openra]?.contexts ?? ['player'];
}

/**
 * Register the GAME_KEYS entries that have a handler (`handlers[entry.handler
 * ?? entry.name]`, called with the entry's `arg` and the key event) and fit
 * the game: `spectator` games take the entries with the spectator context,
 * the others the ones with the player context. Returns an unregister function.
 */
export function registerGameKeys(hotkeys, handlers, { spectator = false } = {}) {
  const context = spectator ? 'spectator' : 'player';
  const offs = [];
  for (const entry of GAME_KEYS) {
    const fn = handlers[entry.handler ?? entry.name];
    if (typeof fn !== 'function' || !keyContexts(entry).includes(context)) continue;
    const { name, openra, keys, label, group, modifiers, inControls, repeat } = entry;
    offs.push(
      hotkeys.registerAction(name, keys, (e) => fn(entry.arg, e), {
        openra,
        label,
        group,
        context,
        modifiers,
        inControls,
        repeat,
      }),
    );
  }
  return () => offs.forEach((off) => off());
}
