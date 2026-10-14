// Runs editor/js/tiles-worker.js inside a Node worker_threads Worker (the
// editor tests and tools/editor-bench.mjs): the browser worker global's
// postMessage and onmessage on top of worker_threads' parentPort.
import { parentPort } from 'node:worker_threads';

globalThis.__webraTilesPort = {
  postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer),
  set onmessage(fn) {
    parentPort.on('message', (data) => fn({ data }));
  },
};
await import('../editor/js/tiles-worker.js');
