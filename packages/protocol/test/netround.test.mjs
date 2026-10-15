// Protocol 8: the start gate, network quality and invite codes
// (docs/contracts.md section 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C2S,
  client,
  DEFAULT_OPTIONS,
  encodeClient,
  encodeServer,
  formatInviteCode,
  INVITE_ALPHABET,
  INVITE_CODE_RE,
  invitePath,
  jitterOf,
  latePercent,
  median,
  MAX_SERVER_MESSAGE_BYTES,
  netBars,
  netQuality,
  normalizeInviteCode,
  parseClientMessage,
  parseServerMessage,
  randomInviteCode,
  S2C,
  SOCIAL_DEFAULTS,
  socialSettings,
  STALL_LOG_MAX,
} from '../src/index.js';

const okC = (m) => {
  const r = parseClientMessage(JSON.stringify(m));
  assert.ok(r.ok, `${JSON.stringify(m)}: ${r.message}`);
  return r.msg;
};
const badC = (m, re) => {
  const r = parseClientMessage(JSON.stringify(m));
  assert.equal(r.ok, false, `accepted ${JSON.stringify(m)}`);
  if (re) assert.match(r.message, re);
};
const okS = (m) => {
  const r = parseServerMessage(JSON.stringify(m));
  assert.ok(r.ok, `${JSON.stringify(m).slice(0, 120)}: ${r.message}`);
  return r.msg;
};
const badS = (m, re) => {
  const r = parseServerMessage(JSON.stringify(m));
  assert.equal(r.ok, false, `accepted ${JSON.stringify(m).slice(0, 120)}`);
  if (re) assert.match(r.message, re);
};

test('ping: n and at always, the measurement all or nothing; late is a percentage rounded to 0.1', () => {
  assert.deepEqual(okC({ t: 'ping', n: 0, at: 123 }), { t: 'ping', n: 0, at: 123 });
  assert.deepEqual(okC({ t: 'ping', n: 7, at: 5, rtt: 34, jitter: 4, late: 0.149 }), { t: 'ping', n: 7, at: 5, rtt: 34, jitter: 4, late: 0.1 });
  badC({ t: 'ping', n: 1, at: 1, rtt: 30 }, /together/);
  badC({ t: 'ping', n: -1, at: 1 }, /n must/);
  badC({ t: 'ping', n: 1, at: 1.5 }, /at must/);
  badC({ t: 'ping', n: 1, at: 1, rtt: 70_000, jitter: 0, late: 0 }, /rtt/);
  badC({ t: 'ping', n: 1, at: 1, rtt: 1, jitter: 0, late: 101 }, /late/);
  badC({ t: 'ping', n: 1, at: 1, rtt: 1, jitter: 0, late: 'x' }, /late/);
  badC({ t: 'ping', n: 1, at: 1, extra: 1 }, /unknown field/);
  assert.equal(encodeClient(client.ping(3, 9)), '{"t":"ping","n":3,"at":9}');
  assert.equal(encodeClient(client.ping(3, 9, { rtt: 20, jitter: 1, late: 0 })), '{"t":"ping","n":3,"at":9,"rtt":20,"jitter":1,"late":0}');
  assert.deepEqual(okC({ t: 'stalls' }), { t: C2S.STALLS });
  assert.deepEqual(okC({ t: 'loaded' }), { t: C2S.LOADED });
  badC({ t: 'loaded', tick: 0 }, /unknown field/);
  assert.equal(encodeClient(client.loaded()), '{"t":"loaded"}');
  assert.equal(encodeClient(client.stalls()), '{"t":"stalls"}');
});

test('pong, netstat, waiting and stalls are strict', () => {
  assert.deepEqual(okS({ t: 'pong', n: 1, at: 2 }), { t: S2C.PONG, n: 1, at: 2 });
  badS({ t: 'pong', n: 1 }, /at/);
  const p = { client: 2, rtt: 40, jitter: 3, late: 0 };
  assert.deepEqual(okS({ t: 'netstat', players: [p, { client: 3, rtt: null, jitter: null, late: null, silent: 6000 }] }).players[1], {
    client: 3,
    rtt: null,
    jitter: null,
    late: null,
    silent: 6000,
  });
  badS({ t: 'netstat', players: [p, p] }, /twice/);
  badS({ t: 'netstat', players: [{ ...p, rtt: null }] }, /all known or all null/);
  badS({ t: 'netstat', players: Array.from({ length: 9 }, (_, i) => ({ ...p, client: i + 1 })) }, /at most 8/);
  assert.deepEqual(okS({ t: 'waiting', client: 4, heldMs: 1500, dropInMs: 8500 }), { t: S2C.WAITING, client: 4, heldMs: 1500, dropInMs: 8500 });
  assert.deepEqual(okS({ t: 'waiting', client: null }), { t: S2C.WAITING, client: null });
  badS({ t: 'waiting', client: null, heldMs: 1 }, /no times/);
  badS({ t: 'waiting', client: 4, heldMs: 1 }, /dropInMs/);
  const stalls = okS({ t: 'stalls', stalls: [{ tick: 200, client: 2, ms: 1800 }], totals: [{ client: 2, ms: 1800, count: 1 }] });
  assert.deepEqual(stalls.stalls, [{ tick: 200, client: 2, ms: 1800 }]);
  badS({ t: 'stalls', stalls: [], totals: [{ client: 2, ms: 1, count: 1 }, { client: 2, ms: 1, count: 1 }] }, /twice/);
  badS({ t: 'stalls', stalls: Array.from({ length: STALL_LOG_MAX + 1 }, () => ({ tick: 1, client: 1, ms: 1 })), totals: [] }, /at most/);
  // A full stall log fits in one server message.
  const full = encodeServer({ t: S2C.STALLS, stalls: Array.from({ length: STALL_LOG_MAX }, (_, i) => ({ tick: 2_000_000_000 - i, client: 2_000_000_000, ms: 86_400_000 })), totals: [] });
  assert.ok(full.length < MAX_SERVER_MESSAGE_BYTES);
});

test('lobby.invite carries a valid code and its expiry', () => {
  const lobby = { t: 'lobby', hostId: null, slots: [{ type: 'open' }, { type: 'open' }], options: DEFAULT_OPTIONS, map: null, spectators: [], maxSpectators: 2 };
  assert.equal(okS(lobby).invite, undefined);
  assert.deepEqual(okS({ ...lobby, invite: { code: 'K7Q2MX', expiresAt: 1000 } }).invite, { code: 'K7Q2MX', expiresAt: 1000 });
  badS({ ...lobby, invite: { code: 'K7Q-2MX', expiresAt: 1000 } }, /invite.code/);
  badS({ ...lobby, invite: { code: 'K7Q2MX' } }, /expiresAt/);
});

test('quality: thresholds shared by lobby, game and statistics', () => {
  assert.equal(netQuality({ rtt: null }), null);
  assert.equal(netQuality({ rtt: 34, jitter: 4, late: 0 }), 'good');
  assert.equal(netQuality({ rtt: 79, jitter: 20, late: 0 }), 'good');
  assert.equal(netQuality({ rtt: 80, jitter: 0, late: 0 }), 'fair');
  assert.equal(netQuality({ rtt: 30, jitter: 21, late: 0 }), 'fair');
  assert.equal(netQuality({ rtt: 30, jitter: 0, late: 1 }), 'fair', 'a few late pings');
  assert.equal(netQuality({ rtt: 150, jitter: 0, late: 2 }), 'fair');
  assert.equal(netQuality({ rtt: 151, jitter: 0, late: 0 }), 'poor');
  assert.equal(netQuality({ rtt: 30, jitter: 0, late: 2.1 }), 'poor');
  assert.deepEqual(['good', 'fair', 'poor', null].map(netBars), [4, 3, 1, 0]);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(median([]), null);
  assert.equal(jitterOf([10, 20, 10, 10]), 7);
  assert.equal(jitterOf([10]), 0);
  assert.equal(latePercent(1, 726), 0.1);
  assert.equal(latePercent(0, 0), 0);
});

test('invite codes: alphabet without look-alikes, normalized input, display form, uniform random codes', () => {
  assert.equal(INVITE_ALPHABET.length, 31);
  for (const c of '01OIL') assert.equal(INVITE_ALPHABET.includes(c), false, c);
  assert.equal(normalizeInviteCode('k7q-2mx'), 'K7Q2MX');
  assert.equal(normalizeInviteCode(' K7Q 2MX '), 'K7Q2MX');
  assert.equal(normalizeInviteCode('https://webra.sherin.dev/join/K7Q-2MX'), 'K7Q2MX');
  assert.equal(normalizeInviteCode('https://webra.sherin.dev/play/?invite=K7Q-2MX'), 'K7Q2MX');
  for (const bad of ['K7Q-2M', 'K7Q-2MXX', 'O7Q-2MX', 'K1Q2MX', '', null, 5, '/join/%E0%A4%A']) assert.equal(normalizeInviteCode(bad), null, String(bad));
  assert.equal(formatInviteCode('K7Q2MX'), 'K7Q-2MX');
  assert.equal(invitePath('K7Q2MX'), '/join/K7Q-2MX');
  // Bytes at or above 248 (8 * 31) are skipped, so 255 never maps to a character.
  const bytes = [255, 0, 30, 31, 61, 248, 100, 200, 247];
  let i = 0;
  const fake = (n) => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]);
  const code = randomInviteCode(fake);
  assert.match(code, INVITE_CODE_RE);
  assert.equal(code, ['2', 'Z', '2', 'Z', INVITE_ALPHABET[100 % 31], INVITE_ALPHABET[200 % 31]].join(''));
  const seen = new Set();
  for (let k = 0; k < 2000; k++) seen.add(randomInviteCode((n) => crypto.getRandomValues(new Uint8Array(n))));
  assert.ok(seen.size > 1990);
});

test('privacy settings: defaults, and only booleans count', () => {
  assert.deepEqual(socialSettings(null), SOCIAL_DEFAULTS);
  assert.deepEqual(SOCIAL_DEFAULTS, { showOnline: true, friendsJoin: true, allowSpectate: false });
  assert.deepEqual(socialSettings({ social: { showOnline: false, allowSpectate: 'yes' } }), { showOnline: false, friendsJoin: true, allowSpectate: false });
  assert.deepEqual(socialSettings({ social: [] }), SOCIAL_DEFAULTS);
});
