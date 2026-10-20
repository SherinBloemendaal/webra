// WebGPU check on the website (the landing page hero and the sign-up form):
// WebRA draws with WebGPU only, so a visitor whose browser lacks it learns
// that before signing up or loading the game, with advice for their browser.
//
//   <div class="notice notice-warning webgpu-notice" data-webgpu-notice hidden></div>
//   initWebgpuCheck();                 // fills and shows every such element when WebGPU is missing
//   showWebgpuNotice(element);         // one element (the sign-up form builds its own)
//
// The check is `navigator.gpu` and one `requestAdapter()` (the default
// adapter, no high-performance GPU woken), raced against a short timeout: a
// browser that does not answer in time is not warned (the game itself checks
// again). The notice is built with DOM calls only (the CSP allows no inline
// script or style).

/** The notice's first line (the same words the game uses). */
export const WEBGPU_TITLE = 'Your browser does not support WebGPU, which WebRA needs.';
/** How long requestAdapter may take before the check gives up (and does not warn). */
export const ADAPTER_TIMEOUT_MS = 2500;

const UNDECIDED = Symbol('undecided');

/**
 * Whether this browser can run WebRA: `{ ok, reason }` with reason
 * `missing` (no navigator.gpu), `no_adapter` (WebGPU is there but no GPU
 * adapter: blocklisted driver, hardware acceleration off), `timeout`
 * (undecided, ok) or null.
 */
export async function checkWebgpu(nav = globalThis.navigator, { timeoutMs = ADAPTER_TIMEOUT_MS, timers = globalThis } = {}) {
  const gpu = nav?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return { ok: false, reason: 'missing' };
  let timer = null;
  try {
    const adapter = await Promise.race([
      Promise.resolve(gpu.requestAdapter()),
      new Promise((resolve) => {
        timer = timers.setTimeout(() => resolve(UNDECIDED), timeoutMs);
      }),
    ]);
    if (adapter === UNDECIDED) return { ok: true, reason: 'timeout' };
    return adapter ? { ok: true, reason: null } : { ok: false, reason: 'no_adapter' };
  } catch {
    return { ok: false, reason: 'no_adapter' };
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
  }
}

/** The browser family from a user agent string (for advice only). */
export function browserOf(ua = '') {
  const s = String(ua);
  const ios = /\b(iPhone|iPad|iPod)\b/.test(s);
  const android = /\bAndroid\b/.test(s);
  const os = ios ? 'ios' : android ? 'android' : /\bWindows\b/.test(s) ? 'windows' : /\bMac OS X\b|\bMacintosh\b/.test(s) ? 'mac' : /\bCrOS\b/.test(s) ? 'chromeos' : /\bLinux\b/.test(s) ? 'linux' : 'other';
  let name = 'other';
  if (ios) name = 'safari';
  else if (/\bFirefox\//.test(s)) name = 'firefox';
  else if (/\bEdg\//.test(s)) name = 'edge';
  else if (/\b(Chrome|Chromium)\//.test(s)) name = 'chrome';
  else if (/\bSafari\//.test(s) && /\bVersion\//.test(s)) name = 'safari';
  return { name, os };
}

/** What the visitor can do: one or two sentences for their browser and the check's reason. */
export function webgpuAdvice({ reason, ua = '' }) {
  if (reason === 'no_adapter') {
    return 'Your browser has WebGPU but found no usable graphics adapter. Switch on hardware acceleration in the browser settings, update your graphics driver, or try Chrome or Edge.';
  }
  const { name, os } = browserOf(ua);
  if (os === 'ios') return 'On iPhone and iPad, update to iOS or iPadOS 26 or later (every browser there uses Safari\'s engine).';
  if (os === 'android') return 'On Android, use an up-to-date Chrome (version 121 or later, Android 12 or later).';
  if (name === 'firefox') {
    return os === 'windows'
      ? 'Update Firefox to version 141 or later, or use Chrome or Edge.'
      : 'Firefox has WebGPU on Windows only so far. Use Chrome or Edge (or Safari 26 on a Mac).';
  }
  if (name === 'safari') return 'Update to Safari 26 or later (macOS), or use Chrome or Edge.';
  if (name === 'chrome' || name === 'edge') {
    return os === 'linux'
      ? 'Update your browser. On Linux, Chrome may need WebGPU switched on (chrome://flags, "Unsafe WebGPU Support"); Windows, macOS and ChromeOS have it by default.'
      : 'Update your browser to Chrome or Edge 113 or later.';
  }
  return 'Use an up-to-date Chrome or Edge (113 or later), Safari 26 or later, or Firefox 141 or later on Windows.';
}

/** Fill `host` with the notice for `result` (built with DOM calls) and show it. */
export function renderWebgpuNotice(host, result, ua = '') {
  const doc = host.ownerDocument;
  const title = doc.createElement('strong');
  title.textContent = `${WEBGPU_TITLE} `;
  const advice = doc.createElement('span');
  advice.textContent = webgpuAdvice({ reason: result.reason, ua });
  host.replaceChildren(title, advice);
  host.setAttribute('role', 'status');
  host.dataset.webgpu = result.reason;
  host.hidden = false;
}

/** Check once and show the notice in `host` when WebGPU is missing. Resolves with the result. */
export async function showWebgpuNotice(host, { nav = globalThis.navigator, check = checkWebgpu } = {}) {
  const result = await check(nav);
  if (!result.ok) renderWebgpuNotice(host, result, nav?.userAgent ?? '');
  return result;
}

/** Every `[data-webgpu-notice]` element of the page (one check for all). */
export async function initWebgpuCheck(root = globalThis.document, { nav = globalThis.navigator, check = checkWebgpu } = {}) {
  const hosts = [...(root?.querySelectorAll?.('[data-webgpu-notice]') ?? [])];
  if (hosts.length === 0) return null;
  const result = await check(nav);
  if (!result.ok) for (const h of hosts) renderWebgpuNotice(h, result, nav?.userAgent ?? '');
  return result;
}
