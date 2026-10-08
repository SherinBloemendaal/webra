// Runs js/sim/worker.js inside a Node worker_threads Worker for the tests
// (sim-fixtures.mjs NodeWorker): the browser worker global's postMessage and
// onmessage on top of worker_threads' parentPort.
import { parentPort } from 'node:worker_threads';

globalThis.__webraSimPort = {
  postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer),
  set onmessage(fn) {
    parentPort.on('message', (data) => fn({ data }));
  },
};
await import('../js/sim/worker.js');
