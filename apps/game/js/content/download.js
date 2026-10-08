// One-click install: OpenRA's ra-quickinstall.zip (Electronic Arts' Red
// Alert files, freeware since 2008) fetched through WebRA's server, which
// streams it from OpenRA's community mirrors without keeping a copy
// (apps/server/src/content.js). The download only starts when the player
// clicks; the bytes are then installed like a ZIP the player picked
// (content/install.js) and stay on this device.

export const QUICKINSTALL_URL = '/api/content/ra-quickinstall';
export const QUICKINSTALL_BYTES = 13_502_031;
/** localStorage key: the player does not want the first start prompt again. */
export const PROMPT_KEY = 'webra.content.prompt.v1';

/**
 * Download the package with progress. Returns a File named
 * ra-quickinstall.zip; throws with a readable message on any problem.
 * @param {{ onProgress?(received: number, total: number): void, fetchImpl?: typeof fetch, signal?: AbortSignal }} [o]
 */
export async function downloadQuickInstall({ onProgress = () => {}, fetchImpl = globalThis.fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(QUICKINSTALL_URL, { headers: { 'X-WebRA-Content': '1' }, cache: 'no-store', signal });
  } catch (err) {
    throw new Error(`the download could not start (${err.message ?? err})`);
  }
  if (res.status === 429) throw new Error('too many downloads from this network; try again in an hour or install the files yourself');
  if (!res.ok || !res.body) {
    let message = `the server answered ${res.status}`;
    try {
      message = (await res.json()).error?.message ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  const out = new Uint8Array(QUICKINSTALL_BYTES);
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > QUICKINSTALL_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('the download is larger than the known package');
    }
    out.set(value, received);
    received += value.byteLength;
    onProgress(received, QUICKINSTALL_BYTES);
  }
  if (received !== QUICKINSTALL_BYTES) throw new Error(`the download stopped after ${received} of ${QUICKINSTALL_BYTES} bytes`);
  return new File([out], 'ra-quickinstall.zip', { type: 'application/zip' });
}

/** Whether to offer the download at start: nothing installed yet and not declined in this browser. */
export function shouldPrompt({ installed, storage = globalThis.localStorage }) {
  if (installed) return false;
  try {
    return storage?.getItem(PROMPT_KEY) !== 'no';
  } catch {
    return false;
  }
}

export function declinePrompt(storage = globalThis.localStorage) {
  try {
    storage?.setItem(PROMPT_KEY, 'no');
  } catch {
    // blocked storage: the prompt comes back next time
  }
}

/** The notice shown with every download button. */
export const DOWNLOAD_NOTICE =
  "These are Electronic Arts' Red Alert files, which EA released as freeware in 2008. WebRA fetches OpenRA's ra-quickinstall.zip from OpenRA's community mirrors through webra.sherin.dev (passed through, never kept on the server) and stores it only on this device.";
