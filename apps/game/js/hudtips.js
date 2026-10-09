// Tooltips of the HUD buttons at the top right of the battlefield (Debug,
// Build / Map on phones, Menu), with the shared tooltip (js/ui/tooltip.js)
// and the keys bound to them now (js/hotkeys.js).

import { boundKey } from './hotkeys.js';
import { attachTooltip } from './ui/tooltip.js';

/** Keys that open the game menu: Esc always, and any key bound to the `menu` action. */
export function menuKeys(hotkeys) {
  const extra = boundKey(hotkeys, 'menu');
  return extra ? `Esc, ${extra}` : 'Esc';
}

/** Tooltip of the Menu button (it reads Resume while the menu is open). */
export function menuTip(hotkeys, open) {
  return open
    ? { title: 'Resume', hotkey: menuKeys(hotkeys), desc: 'Close the game menu and go back to the battle.' }
    : { title: 'Game menu', hotkey: menuKeys(hotkeys), desc: 'Settings, controls, sound, saving and leaving the game.' };
}

/** Tooltip of the Debug button. */
export function debugTip(hotkeys, cheats) {
  return {
    title: 'Debug menu',
    hotkey: boundKey(hotkeys, 'debugMenu'),
    desc: cheats ? 'Cheats, debug views and stepping while paused.' : 'Debug views and performance numbers.',
  };
}

/** Tooltip of the phone layout's sidebar toggle (it reads Build or Map). */
export function sidebarToggleTip(collapsed) {
  return collapsed
    ? { title: 'Show the build sidebar', desc: 'Production, the radar and the sidebar buttons.' }
    : { title: 'Hide the build sidebar', desc: 'Back to the whole battlefield.' };
}

/**
 * Attach the tooltips. `isMenuOpen()` and `isCollapsed()` read the state the
 * buttons show. Returns a function that removes them.
 */
export function attachHudTooltips({ hotkeys, menuButton, debugButton = null, cheats = false, toggle = null, isMenuOpen, isCollapsed }) {
  const tips = [attachTooltip(menuButton, () => menuTip(hotkeys, isMenuOpen()), { side: 'bottom' })];
  if (debugButton) tips.push(attachTooltip(debugButton, () => debugTip(hotkeys, cheats), { side: 'bottom' }));
  if (toggle) tips.push(attachTooltip(toggle, () => sidebarToggleTip(isCollapsed()), { side: 'bottom' }));
  const off = hotkeys.onChange(() => tips.forEach((t) => t.refresh()));
  return () => {
    off();
    tips.forEach((t) => t.detach());
  };
}
