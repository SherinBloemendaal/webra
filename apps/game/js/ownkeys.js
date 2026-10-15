// Keys a control keeps for itself: a screen's own key handler (Esc closes
// the campaign screen or a records dialog) lets them through untouched when
// they come from inside a select's list, a stepper or a tab row
// (js/ui/controls.js), or from a select's panel (focus is only there while
// it is open), so the control gets its arrows and Esc closes the list
// instead of the screen.

/** The controls that use the arrows, Home, End and Esc themselves. */
export const OWN_KEYS_SELECTOR = '[role="listbox"], [role="spinbutton"], [role="tablist"], .ui-sp-panel';

/** Whether a key event from `target` belongs to the control it came from. */
export function controlOwnsKey(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(OWN_KEYS_SELECTOR));
}
