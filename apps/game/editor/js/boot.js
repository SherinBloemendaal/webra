// The map editor's boot screen: the game's boot screen (js/bootscreen.js,
// css/loading.css) with the editor's own steps, from the page's first paint
// until the editor is usable. editor/index.html has it as static markup
// (#boot with `data-boot="editor"`, the same lamps as EDITOR_BOOT_STEPS) and
// loads this module on its own ahead of editor/editor.js, which imports it
// and goes on with the steps (`bootEditor`).
//
// It goes once the first frame of the map is drawn; installed terrain tiles
// planned in a worker (js/tiles.js) get at most BOOT_WAIT_MS more, so the
// map does not change its look right after the screen goes. It never hangs:
// a step that fails shows its error with Reload, the editor files that do
// not load too, and after a long wait a line with Reload shows by CSS alone.

import { BootScreen, watchGameFiles } from '../../js/bootscreen.js';

/** The editor's boot steps in screen order (editor/index.html has the same lamps). */
export const EDITOR_BOOT_STEPS = Object.freeze([
  Object.freeze({ id: 'files', label: 'Loading the editor files' }),
  Object.freeze({ id: 'engine', label: 'Starting the engine' }),
  Object.freeze({ id: 'rules', label: 'Reading the rules' }),
  Object.freeze({ id: 'graphics', label: 'Checking the graphics card' }),
  Object.freeze({ id: 'content', label: 'Reading installed content' }),
  Object.freeze({ id: 'map', label: 'Opening the map' }),
  Object.freeze({ id: 'tiles', label: 'Laying the terrain tiles' }),
  Object.freeze({ id: 'editor', label: 'Opening the editor' }),
]);

/** Steps the editor does not need to be usable: the screen waits at most BOOT_WAIT_MS for them. */
export const EDITOR_BOOT_OPTIONAL = Object.freeze(['tiles']);

/** The boot screen of `root` (editor/index.html #boot) with the editor's steps. */
export function editorBootScreen(root, o = {}) {
  return new BootScreen(root, { steps: EDITOR_BOOT_STEPS, optional: EDITOR_BOOT_OPTIONAL, app: 'The map editor', ...o });
}

/** A step's work as a promise: what it returns, or its error (thrown at once or later). */
const run = (fn) => Promise.resolve().then(fn);

/**
 * The editor's boot on `screen`, step by step. `work` has a function per
 * step: `engine`, `rules`, `graphics`, `content` and `map` (each may return
 * a promise), `editor` (builds the editor; resolves once its first frame is
 * drawn) and `tiles` (after that frame: a promise for the installed tiles
 * being planned, or null when the drawn tiles are final). A step that
 * fails shows its error on the screen (with Reload) and the boot stops.
 * Resolves with whether the editor started; the screen is gone by then
 * (`screen.closed`) or shows the error.
 */
export async function bootEditor(screen, work, { reducedMotion = null } = {}) {
  screen.started({ reducedMotion });
  try {
    for (const id of ['engine', 'rules', 'graphics', 'content', 'map']) await screen.track(id, run(work[id]));
    await screen.track('editor', run(work.editor));
  } catch (err) {
    console.error(err);
    screen.fail(err);
    return false;
  }
  const tiles = work.tiles?.();
  if (tiles) screen.track('tiles', tiles);
  else screen.set('tiles', 'done');
  await screen.ready();
  return true;
}

/** The page's boot screen (editor/index.html #boot): editor/editor.js reports its steps here. */
export const editorBoot = editorBootScreen(globalThis.document?.getElementById?.('boot') ?? null);
watchGameFiles(editorBoot, { main: 'editor/editor.js', files: 'the editor files' });
