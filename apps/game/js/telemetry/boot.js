// Starts error reports (js/telemetry/index.js) before the game's own modules
// load, so errors while they load are reported too. The game page and the
// map editor load it ahead of their main module.
import { initTelemetry, setTags } from './index.js';

const editor = /\/editor\/?(index\.html)?$/.test(globalThis.location?.pathname ?? '');
setTags({ mode: editor ? 'editor' : 'menu' });
initTelemetry({ surface: 'game' });
