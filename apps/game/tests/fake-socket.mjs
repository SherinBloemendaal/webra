// A WebSocket stand-in for js/net.js Connection tests: the test opens the
// socket and delivers server messages (JSON) by hand; no network.
//
//   await withFakeSocket(async () => {
//     const opened = new Connection(id).open({ version, name });
//     FakeSocket.last.connect();
//     FakeSocket.last.deliver(WELCOME);
//     await opened;
//   });

/** A WebSocket stand-in: the test opens it and delivers server messages by hand. */
export class FakeSocket {
  static OPEN = 1;
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closes = 0;
    FakeSocket.last = this;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closes++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close');
  }
  connect() {
    this.readyState = FakeSocket.OPEN;
    this.fire('open');
  }
  deliver(msg) {
    this.fire('message', { data: JSON.stringify(msg) });
  }
}

export const WELCOME = {
  t: 'welcome',
  you: 2,
  name: 'Ivan',
  hostId: 1,
  session: { id: 'a'.repeat(64), name: 'Lobby', public: true, locked: false, maxPlayers: 2, version: '0.17.0' },
  role: 'player',
};

/** Run `fn` with the fake socket as the global WebSocket (and a page location). */
export async function withFakeSocket(fn) {
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location };
  globalThis.WebSocket = FakeSocket;
  globalThis.location = { protocol: 'https:', host: 'webra.example' };
  try {
    await fn();
  } finally {
    globalThis.WebSocket = saved.WebSocket;
    if (saved.location === undefined) delete globalThis.location;
    else globalThis.location = saved.location;
  }
}
