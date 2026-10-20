// The website's WebGPU check (apps/website/assets/webgpu-check.js) on a fake
// DOM: the landing page and the sign-up form tell a visitor without WebGPU
// before they sign up, with advice for their browser; nothing shows when
// WebGPU works or the check cannot decide in time. No inline script or style.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, uninstallDom } from './dom-fixtures.mjs';
import { FakeTimers } from './fake-timers.mjs';
import { browserOf, checkWebgpu, initWebgpuCheck, showWebgpuNotice, WEBGPU_TITLE, webgpuAdvice } from '../../website/assets/webgpu-check.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

const nav = (gpu, userAgent = UA.chromeWin) => ({ gpu, userAgent });
const gpuWith = (adapter) => ({ requestAdapter: async () => adapter });

test('check: no navigator.gpu, no adapter, a throwing adapter request, a working one', async () => {
  assert.deepEqual(await checkWebgpu(nav(undefined)), { ok: false, reason: 'missing' });
  assert.deepEqual(await checkWebgpu(nav({})), { ok: false, reason: 'missing' });
  assert.deepEqual(await checkWebgpu(nav(gpuWith(null))), { ok: false, reason: 'no_adapter' });
  assert.deepEqual(await checkWebgpu(nav({ requestAdapter: async () => { throw new Error('blocked'); } })), { ok: false, reason: 'no_adapter' });
  assert.deepEqual(await checkWebgpu(nav(gpuWith({ features: new Set() }))), { ok: true, reason: null });
});

test('check: an adapter request that does not answer in time is not a warning (the game checks again)', async () => {
  const timers = new FakeTimers();
  const pending = checkWebgpu(nav({ requestAdapter: () => new Promise(() => {}) }), { timeoutMs: 2500, timers });
  timers.advance(2500);
  assert.deepEqual(await pending, { ok: true, reason: 'timeout' });
});

test('advice per browser: iOS, Android, Firefox on and off Windows, Safari, Chrome on Linux, a missing adapter', () => {
  assert.deepEqual(browserOf(UA.edge), { name: 'edge', os: 'windows' });
  assert.deepEqual(browserOf(UA.iphone), { name: 'safari', os: 'ios' });
  assert.deepEqual(browserOf(UA.safariMac), { name: 'safari', os: 'mac' });
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.iphone }), /iOS or iPadOS 26/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.android }), /Android/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.firefoxWin }), /Firefox to version 141/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.firefoxLinux }), /Windows only/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.safariMac }), /Safari 26/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.chromeLinux }), /chrome:\/\/flags/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: UA.chromeWin }), /113 or later/);
  assert.match(webgpuAdvice({ reason: 'missing', ua: '' }), /Chrome or Edge/);
  assert.match(webgpuAdvice({ reason: 'no_adapter', ua: UA.chromeWin }), /hardware acceleration/);
});

test('landing page: the hero placeholder is filled and shown without WebGPU, and stays hidden with it', async () => {
  const html = readFileSync(new URL('../../website/index.html', import.meta.url), 'utf8');
  assert.match(html, /<p class="notice notice-warning webgpu-notice" data-webgpu-notice hidden><\/p>/);
  const host = doc.createElement('p');
  host.setAttribute('data-webgpu-notice', '');
  host.hidden = true;
  doc.body.append(host);
  const missing = await initWebgpuCheck(doc, { nav: nav(undefined, UA.firefoxLinux) });
  assert.equal(missing.ok, false);
  assert.equal(host.hidden, false);
  assert.equal(host.getAttribute('role'), 'status');
  assert.match(host.textContent, new RegExp(`^${WEBGPU_TITLE.replace(/\./g, '\\.')} Firefox has WebGPU on Windows only`));
  uninstallDom();
  doc = installDom();
  const ok = doc.createElement('p');
  ok.setAttribute('data-webgpu-notice', '');
  ok.hidden = true;
  doc.body.append(ok);
  assert.equal((await initWebgpuCheck(doc, { nav: nav(gpuWith({})) })).ok, true);
  assert.equal(ok.hidden, true);
  assert.equal(ok.textContent, '');
  assert.equal(await initWebgpuCheck(doc.createElement('div'), { nav: nav(undefined) }), null, 'no placeholder: no check');
});

test('sign-up form: the notice sits in the form; the site script and the account page load the check, CSP-safe', async () => {
  const host = doc.createElement('p');
  host.hidden = true;
  await showWebgpuNotice(host, { nav: nav(gpuWith(null), UA.edge) });
  assert.equal(host.hidden, false);
  assert.equal(host.dataset.webgpu, 'no_adapter');
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const site = read('../../website/assets/site.js');
  assert.match(site, /import \{ initWebgpuCheck \} from '\.\/webgpu-check\.js';/);
  assert.match(site, /home: \(\) => Promise\.all\(\[[^\]]*initWebgpuCheck\(\)/);
  const account = read('../../website/assets/account.js');
  assert.match(account, /showWebgpuNotice\(webgpu\)/);
  const src = read('../../website/assets/webgpu-check.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|\.style\b|setAttribute\('style'|on[a-z]+=/);
});
