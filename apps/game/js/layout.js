// Responsive game screen: which layout the window gets (desktop, portrait
// phone, landscape phone), the collapsible build sidebar drawer, the compact
// HUD text and the render resolution. The pure helpers at the top are tested
// in apps/game/tests/touch.test.mjs; css/touch.css styles each layout through
// the data-layout attribute that Layout puts on #app.

/** Smallest comfortable touch target (CSS px), Apple and WCAG guidance. */
export const TOUCH_TARGET = 44;

/** Phones: portrait up to this width, landscape up to this height. */
export const PHONE_PORTRAIT_MAX_WIDTH = 720;
export const PHONE_LANDSCAPE_MAX_HEIGHT = 500;

/**
 * Layout for a viewport of w x h CSS px: 'portrait' (sidebar becomes a
 * bottom drawer), 'landscape' (narrow right drawer) or 'desktop'.
 */
export function layoutMode(w, h) {
  if (w <= PHONE_PORTRAIT_MAX_WIDTH && h >= w) return 'portrait';
  if (h <= PHONE_LANDSCAPE_MAX_HEIGHT && w > h) return 'landscape';
  return 'desktop';
}

/** Phone layouts get the compact HUD and the drawer toggle. */
export const isCompact = (mode) => mode === 'portrait' || mode === 'landscape';

/**
 * Canvas pixels per CSS pixel. `cap` limits high-density screens (phones
 * report 3 or more, which costs mobile GPUs 9x the pixels of 1x); low quality
 * renders below CSS resolution and lets the browser scale the canvas up.
 */
export const LOW_QUALITY_RATIO = 0.75;

export function renderPixelRatio(deviceRatio, cap, lowQuality = false) {
  const device = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 2;
  const ratio = Math.min(device, limit);
  return lowQuality ? Math.min(ratio, LOW_QUALITY_RATIO) : ratio;
}

/**
 * HUD line over the battlefield. The game clock lives in the sidebar
 * (js/sidebar.js), and frame stats in the debug menu's performance panel
 * (js/debug.js), so a normal game shows only the pause state. Stress tests
 * add fps, simulation cost, unit and flow field counts; compact layouts keep
 * fps and units.
 */
export function hudText({ paused = false, fps = 0, simMs = 0, stress = false, units = 0, flowFields = 0 }, compact = false) {
  const parts = paused ? ['Paused'] : [];
  if (stress) {
    parts.push(`${fps.toFixed(0)} fps`);
    if (!compact) parts.push(`sim ${simMs.toFixed(2)} ms/tick`);
    parts.push(`${units} units`);
    if (!compact) parts.push(`${flowFields} flow fields`);
  }
  return parts.join(compact ? '  ' : '  |  ');
}

/**
 * Drawer state: the player's choice (open or collapsed) plus a temporary
 * collapse while a building is being placed on a phone, so the whole map is
 * free for the footprint. Placement ending restores the player's choice.
 */
export class DrawerState {
  constructor() {
    this.collapsed = false; // the player's choice
    this.placing = false;
  }

  /** Whether the drawer is shown collapsed in a compact layout. */
  shownCollapsed(compact) {
    return compact && (this.collapsed || this.placing);
  }

  toggle() {
    // Tapping the toggle while it is hidden for placement opens it again.
    if (this.placing) {
      this.placing = false;
      this.collapsed = false;
    } else this.collapsed = !this.collapsed;
  }

  setPlacing(on) {
    this.placing = !!on;
  }
}

/**
 * Binds the layout to the page: data-layout on #app (on resize and rotation),
 * the drawer toggle button, and a callback when the mode changes.
 */
export class Layout {
  /**
   * @param {{ app: HTMLElement, toggle: HTMLButtonElement, win?: Window, onChange?: (mode: string) => void }} opts
   */
  constructor({ app, toggle, win = window, onChange }) {
    this.app = app;
    this.toggleButton = toggle;
    this.win = win;
    this.onChange = onChange;
    this.drawer = new DrawerState();
    this.mode = null;
    toggle.addEventListener('click', () => {
      this.drawer.toggle();
      this.apply();
    });
    const update = () => this.update();
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    this.update();
  }

  get compact() {
    return isCompact(this.mode);
  }

  update() {
    const mode = layoutMode(this.win.innerWidth, this.win.innerHeight);
    const changed = mode !== this.mode;
    this.mode = mode;
    this.apply();
    if (changed) this.onChange?.(mode);
  }

  apply() {
    const collapsed = this.drawer.shownCollapsed(this.compact);
    this.app.dataset.layout = this.mode;
    this.app.classList.toggle('sidebar-collapsed', collapsed);
    this.toggleButton.hidden = !this.compact;
    this.toggleButton.setAttribute('aria-expanded', String(!collapsed));
    this.toggleButton.textContent = collapsed ? 'Build' : 'Map';
    this.toggleButton.title = collapsed ? 'Show the build sidebar' : 'Hide the build sidebar';
  }

  /** Building placement started or ended (collapses the drawer on phones meanwhile). */
  setPlacing(on) {
    this.drawer.setPlacing(on);
    this.apply();
  }
}
