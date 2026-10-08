// Fullscreen (Alt+Enter, or the button in the game menu) through the
// Fullscreen API, with the WebKit prefix for older Safari. Where the browser
// supports Keyboard Lock (Chromium), Esc and the digit row are locked while
// fullscreen so Esc opens the game menu (hold Esc to leave fullscreen) and
// Cmd/Ctrl+number reaches the control groups instead of switching tabs.

const LOCK_KEYS = ['Escape', 'Tab', 'F1', 'F2', 'F3', 'F4', ...Array.from({ length: 10 }, (_, i) => `Digit${i}`)];

export const UNAVAILABLE = 'Fullscreen is not available in this browser or page. Use the browser menu (View, Full screen) instead.';

function element(doc) {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** True when the page can go fullscreen. */
export function fullscreenAvailable(doc = globalThis.document) {
  if (!doc) return false;
  const root = doc.documentElement;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  return !!enabled && !!(root?.requestFullscreen || root?.webkitRequestFullscreen);
}

export function isFullscreen(doc = globalThis.document) {
  return !!(doc && element(doc));
}

/**
 * Enter or leave fullscreen. Resolves { ok: true, fullscreen } or
 * { ok: false, message } (no support, or the browser refused).
 */
export async function toggleFullscreen(doc = globalThis.document) {
  if (!fullscreenAvailable(doc)) return { ok: false, message: UNAVAILABLE };
  try {
    if (element(doc)) {
      await (doc.exitFullscreen ?? doc.webkitExitFullscreen).call(doc);
      return { ok: true, fullscreen: false };
    }
    const root = doc.documentElement;
    await (root.requestFullscreen ?? root.webkitRequestFullscreen).call(root);
    try {
      await globalThis.navigator?.keyboard?.lock?.(LOCK_KEYS);
    } catch {
      // Keyboard Lock is optional.
    }
    return { ok: true, fullscreen: true };
  } catch (err) {
    return { ok: false, message: `Could not switch fullscreen: ${err?.message ?? err}` };
  }
}

/** Call `fn(isFullscreen)` when fullscreen changes. Returns a function that stops listening. */
export function onFullscreenChange(fn, doc = globalThis.document) {
  const handler = () => {
    if (!element(doc)) globalThis.navigator?.keyboard?.unlock?.();
    fn(isFullscreen(doc));
  };
  doc.addEventListener('fullscreenchange', handler);
  doc.addEventListener('webkitfullscreenchange', handler);
  return () => {
    doc.removeEventListener('fullscreenchange', handler);
    doc.removeEventListener('webkitfullscreenchange', handler);
  };
}
