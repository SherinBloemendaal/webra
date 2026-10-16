// A small in-memory stand-in for the Durable Object runtime, so the real
// Session class (src/session.js) runs under `node --test`: storage, alarms,
// hibernatable WebSockets with attachments, and a D1 binding that accepts
// every statement. `cloudflare:workers` and the engine module are replaced by
// stubs through a module resolve hook.
import { registerHooks } from 'node:module';

const STUBS = {
  'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
  '#engine-wasm': 'export default null;',
};

// The Worker tests (accounts-harness.mjs) set WEBRA_TEST_REAL_ENGINE so map
// uploads run the real engine; the session tests do not need it.
if (globalThis.WEBRA_TEST_REAL_ENGINE) delete STUBS['#engine-wasm'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(STUBS, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { Session, readAuthHeader } = await import('../src/session.js');
export { readAuthHeader };

// Runtime globals the realtime hub (src/userhub.js) uses: a socket pair
// (client side, server side) and the auto response pair it registers.
globalThis.WebSocketPair ??= class {
  constructor() {
    this[0] = new FakeSocket('client');
    this[1] = new FakeSocket('server');
  }
};
globalThis.WebSocketRequestResponsePair ??= class {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

export class FakeStorage {
  constructor() {
    this.data = new Map();
    this.alarm = null;
  }

  async get(key) {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))]));
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }

  async put(key, value) {
    if (typeof key === 'object') {
      for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    } else {
      this.data.set(key, structuredClone(value));
    }
  }

  async delete(key) {
    return this.data.delete(key);
  }

  async deleteAll() {
    this.data.clear();
  }

  async getAlarm() {
    return this.alarm;
  }

  async setAlarm(at) {
    this.alarm = at;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

export class FakeSocket {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.closed = null;
    this.att = null;
    /** Hibernation tags given to acceptWebSocket. */
    this.tags = [];
  }

  serializeAttachment(value) {
    this.att = structuredClone(value);
  }

  deserializeAttachment() {
    return structuredClone(this.att);
  }

  send(raw) {
    if (this.closed) throw new Error('socket closed');
    this.inbox.push(JSON.parse(raw));
  }

  close(code, reason) {
    this.closed ??= { code, reason };
  }

  /** Remove and return every received message of type `t`. */
  take(t) {
    const out = this.inbox.filter((m) => m.t === t);
    this.inbox = this.inbox.filter((m) => m.t !== t);
    return out;
  }

  last(t) {
    return this.inbox.filter((m) => m.t === t).at(-1);
  }
}

const db = {
  prepare: () => ({
    bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }),
  }),
};

/**
 * A session Durable Object with its fake runtime. `autoLoaded`: after a
 * `start`, every player's socket reports `loaded` at once (clients whose
 * loading screen closes instantly), so tests about other things need not
 * pass the start gate themselves.
 */
export async function makeSession({ maxPlayers = 3, password = null, version = '1.0.0', DB = db, isPublic = false, autoLoaded = true, env = {} } = {}) {
  const sockets = [];
  const ctx = {
    storage: new FakeStorage(),
    getWebSockets: () => sockets.filter((s) => !s.closed),
    acceptWebSocket: (ws) => sockets.push(ws),
    blockConcurrencyWhile: (fn) => fn(),
  };
  // `env`: more bindings (USER_HUB for the realtime presence hints).
  const session = new Session(ctx, { DB, ...env });
  await new Promise((r) => setTimeout(r, 0));
  const { hostKey } = await session.init({ id: 'a'.repeat(64), name: 'Test', password, isPublic, maxPlayers, version });
  const send = async (ws, msg) => {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    await session.webSocketMessage(ws, raw);
    if (autoLoaded && JSON.parse(raw).t === 'start' && session.lockstep?.starting) {
      for (const other of ctx.getWebSockets()) {
        const att = other.deserializeAttachment();
        if (att?.client && !att.gone && session.room.seatOf(att.client) >= 0) await session.webSocketMessage(other, '{"t":"loaded"}');
      }
    }
  };
  let ip = 1;
  const api = {
    session,
    ctx,
    hostKey,
    version,
    /** A new socket, as after the WebSocket upgrade. */
    /** `auth`: the Worker's verdict ({ account, refuse }) as Session.fetch reads it from X-WebRA-Auth. */
    connect(name = 'socket', addr = `10.0.0.${ip++}`, auth = { account: null, refuse: null }) {
      const ws = new FakeSocket(name);
      ctx.acceptWebSocket(ws);
      ws.serializeAttachment({ client: null, ip: addr, since: Date.now(), busy: false, account: auth.account, refuse: auth.refuse });
      return ws;
    },
    send,
    /** The client side closed the socket. */
    async drop(ws) {
      ws.close(1006, 'gone');
      await session.webSocketClose(ws, 1006, 'gone', false);
    },
  };
  return api;
}

/**
 * The Durable Object state of a realtime hub: storage, hibernatable sockets
 * with tags (getWebSockets(tag) filters, closed sockets drop out) and the
 * recorded auto response.
 */
export function makeHubCtx() {
  const sockets = [];
  return {
    sockets,
    storage: new FakeStorage(),
    autoResponse: null,
    getWebSockets: (tag) => sockets.filter((s) => !s.closed && (tag === undefined || s.tags.includes(tag))),
    acceptWebSocket: (ws, tags = []) => {
      ws.tags = [...tags];
      sockets.push(ws);
    },
    setWebSocketAutoResponse(pair) {
      this.autoResponse = pair;
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
}
