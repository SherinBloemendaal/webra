// What error reports must not carry (src/scrub.js): players' text, URL
// secrets, email addresses, tokens, headers, cookies, bodies, addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERED, REDACTED, Redactor, scrubBreadcrumb, scrubEvent, scrubText, scrubUrl, scrubValue } from '../src/index.js';

test('Redactor: remembers players text from JSON by key, newest first, and replaces it anywhere', () => {
  const r = new Redactor({ max: 3 });
  r.harvest({ t: 'lobby', players: [{ name: 'Boris', faction: 'russia' }, { name: 'Al' }], chat: { text: 'gg wp' }, password: 'hunter2', id: 'abc123' });
  assert.equal(r.scrub('Boris said gg wp to Al'), `${REDACTED} said ${REDACTED} to Al`, 'shorter than 3 characters: kept');
  assert.equal(r.scrub('hunter2 abc123'), 'hunter2 abc123', 'only text keys are remembered');
  r.add('12345');
  assert.equal(r.scrub('tick 12345'), 'tick 12345', 'numbers alone are not players text');
  r.add('a.b*c');
  assert.equal(r.scrub('x a.b*c y'), `x ${REDACTED} y`, 'regex characters are literal');
  r.add('Bridge');
  r.add('Delta');
  assert.equal(r.scrub('Boris'), 'Boris', 'the oldest is forgotten past max');
  // The longest match wins.
  const s = new Redactor();
  s.add('Tanya');
  s.add('Tanya Adams');
  assert.equal(s.scrub('by Tanya Adams'), `by ${REDACTED}`);
  assert.equal(s.scrub(42), 42);
});

test('scrubUrl: no user info, query values, fragments or token-like path segments', () => {
  assert.equal(scrubUrl('https://user:pw@webra.sherin.dev/play/?join=abc&instances=gpu#join=abc'), `https://webra.sherin.dev/play/?join=${FILTERED}&instances=${FILTERED}#${FILTERED}`);
  assert.equal(scrubUrl(`/api/sessions/${'f'.repeat(64)}/ws`), `/api/sessions/${FILTERED}/ws`);
  assert.equal(scrubUrl('/api/auth/discord/callback?code=xyz&state=abc'), `/api/auth/discord/callback?code=${FILTERED}&state=${FILTERED}`);
  assert.equal(scrubUrl('https://webra.sherin.dev/play/js/releasenotes-dialog.js'), 'https://webra.sherin.dev/play/js/releasenotes-dialog.js');
  assert.equal(scrubUrl('wss://webra.sherin.dev/api/sessions/x/ws?k=1'), `wss://webra.sherin.dev/api/sessions/x/ws?k=${FILTERED}`);
  assert.equal(scrubUrl(''), '');
  assert.equal(scrubUrl(undefined), undefined);
});

test('scrubText: URLs, email addresses, long tokens and remembered text', () => {
  const r = new Redactor();
  r.add('Friday night ops');
  assert.equal(
    scrubText(`GET https://webra.sherin.dev/api/x?key=s3cret failed for bob@example.org in Friday night ops with ${'Ab9_'.repeat(10)}, hash 00000000deadbeef`, r),
    `GET https://webra.sherin.dev/api/x?key=${FILTERED} failed for [email] in ${REDACTED} with ${FILTERED}, hash 00000000deadbeef`,
  );
});

test('scrubValue: secret-named keys go, URLs are scrubbed, depth is bounded', () => {
  const v = scrubValue({ password: 'x', rejoinKey: 'y', memberHeader: 'z', cookie: 'c', authorization: 'a', url: '/a?b=c', nested: { list: ['bob@example.org'] } });
  assert.deepEqual(v, { url: `/a?b=${FILTERED}`, nested: { list: ['[email]'] } });
  let deep = {};
  const root = deep;
  for (let i = 0; i < 10; i++) deep = deep.next = {};
  assert.match(JSON.stringify(scrubValue(root)), /\[\.\.\.\]/);
});

test('scrubBreadcrumb: console arguments go, DOM attribute values go, URLs are scrubbed', () => {
  assert.deepEqual(scrubBreadcrumb({ category: 'console', level: 'warning', message: 'see https://x.dev/?t=1', data: { arguments: ['secret'], logger: 'console' } }), {
    category: 'console',
    level: 'warning',
    message: `see https://x.dev/?t=${FILTERED}`,
    data: { logger: 'console' },
  });
  assert.equal(scrubBreadcrumb({ category: 'ui.input', message: "input#chat[placeholder='Say something'][name=chat]" }).message, 'input#chat[placeholder][name]');
  assert.deepEqual(scrubBreadcrumb({ category: 'xhr', data: { url: '/api/maps?q=mine', method: 'GET', status_code: 500 } }).data, { url: `/api/maps?q=${FILTERED}`, method: 'GET', status_code: 500 });
  assert.equal(scrubBreadcrumb({ category: 'console', level: 'log', message: 'retention {}' }), null, 'console logs: only warnings and errors');
  assert.deepEqual(scrubEvent({ breadcrumbs: [{ category: 'console', level: 'info', message: 'x' }, { category: 'navigation', data: { to: '/play/?a=b' } }] }).breadcrumbs, [{ category: 'navigation', data: { to: `/play/?a=${FILTERED}` } }]);
  assert.equal(scrubBreadcrumb(null), null);
});

test('scrubEvent: a Worker transaction keeps no headers, user agents, addresses, queries or bodies', () => {
  const out = scrubEvent({
    type: 'transaction',
    transaction: 'GET /api/sessions/x/map',
    request: { url: 'https://webra.sherin.dev/api/sessions/x/map?hash=abc', method: 'GET', headers: { 'user-agent': 'UA', cookie: 'c', 'x-webra-member': 'm' }, data: 'body' },
    user: { ip_address: '198.51.100.7' },
    contexts: {
      trace: { data: { 'url.full': 'https://webra.sherin.dev/api/x?key=1', 'url.query': '?key=1', 'http.request.header.x_webra_member': 'm', 'user_agent.original': 'UA', 'client.address': '198.51.100.7', 'http.request.body.size': 12, 'http.response.status_code': 200 } },
      culture: { timezone: 'UTC' },
      cloud_resource: { 'cloud.provider': 'cloudflare' },
    },
    spans: [{ description: 'GET https://archive.org/download/x?token=1', data: { 'http.query': '?token=1', 'server.address': 'archive.org' } }],
  });
  assert.deepEqual(out.request, { url: `https://webra.sherin.dev/api/sessions/x/map?hash=${FILTERED}`, method: 'GET' });
  assert.equal(out.user, undefined);
  assert.deepEqual(out.contexts.trace.data, { 'url.full': `https://webra.sherin.dev/api/x?key=${FILTERED}`, 'http.response.status_code': 200 });
  assert.equal(out.contexts.culture, undefined);
  assert.deepEqual(out.contexts.cloud_resource, { 'cloud.provider': 'cloudflare' });
  assert.deepEqual(out.spans, [{ description: `GET https://archive.org/download/x?${FILTERED}`, data: { 'server.address': 'archive.org' } }]);
  assert.doesNotMatch(JSON.stringify(out), /198\.51\.100\.7|UA|body|"m"/);
});
