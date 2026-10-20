// A WebSocket upgrade the Worker refuses itself (src/index.js
// connectSession): the Worker accepts its own socket pair, sends the
// protocol's `error` message with the reason and closes with 1008, so the
// game shows why (js/net.js) and the session's Durable Object is never
// woken. A refused player thus holds none of the session's pending sockets.

import { errorMessage } from '@webra/protocol';

/** Close code of a refused connection (policy violation), as the session object uses. */
export const CLOSE_POLICY = 1008;

/**
 * How a 101 answer is made. Node's Response has no 101: the Worker tests
 * replace `respond` to read what the server side sent.
 */
export const upgrades = {
  respond: (client) => new Response(null, { status: 101, webSocket: client }),
};

/** Answer an upgrade with `refuse` ({ code, message }) and a closed socket. */
export function refuseUpgrade(refuse) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(errorMessage(refuse.code, refuse.message));
  server.close(CLOSE_POLICY, refuse.code.slice(0, 64));
  return upgrades.respond(client, server);
}
