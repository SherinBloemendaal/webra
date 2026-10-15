// Esc a control keeps for itself: a screen's own Esc (closing the campaign
// screen or a records dialog) does nothing while focus is in an open
// select's list (js/ui/controls.js selectPlate: focus is only in its panel
// while it is open), so Esc closes the list and not the screen. Tab rows and
// steppers use only the arrows, Home, End and Page keys: Esc from them still
// closes the screen.

/** Where Esc belongs to the control: an open select list. */
export const OWN_ESC_SELECTOR = '[role="listbox"], .ui-sp-panel';

/** Whether Esc from `target` belongs to the control it came from. */
export function controlOwnsKey(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(OWN_ESC_SELECTOR));
}
