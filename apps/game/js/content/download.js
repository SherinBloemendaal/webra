// Getting the original content: OpenRA's ra-quickinstall.zip (Electronic
// Arts' Red Alert files, freeware since 2008).
//
// Everyone: the player downloads the ZIP from one of OpenRA's community
// mirrors (QUICKINSTALL_MIRRORS, plain links) and drops or picks it in the
// game (content/panel.js), which installs it like any picked file
// (content/install.js).
//
// Selected accounts (the account flag content_autoinstall, and admins): a
// one-click download through WebRA's server, which streams the ZIP from the
// mirrors without keeping a copy (apps/server/src/content.js). It only
// starts when the player clicks; the bytes stay on this device.

export const QUICKINSTALL_URL = '/api/content/ra-quickinstall';
export const QUICKINSTALL_BYTES = 13_502_031;
/** Settings registry place of "the start screen notice was dismissed" (js/registry.js). */
export const NOTICE_SETTING = Object.freeze(['extra', 'contentNoticeDismissed']);

/**
 * OpenRA's quick install mirrors (OpenRA mods/ra/installer): EA's freeware
 * files as one ZIP of QUICKINSTALL_BYTES, hosted by third parties. Plain
 * links only: the player downloads the file and picks or drops it in the
 * game. The game never fetches them (the mirrors send no CORS headers, and
 * the game's CSP and COEP forbid it).
 */
export const QUICKINSTALL_MIRRORS = Object.freeze([
  'https://openra.baxxster.no/openra/ra-quickinstall.zip',
  'https://republic.community/hosted/files/command-and-conquer/openra/ra-quickinstall.zip',
  'https://openra.0x47.net/ra-quickinstall.zip',
  'https://openra.ppmsite.com/ra-quickinstall.zip',
]);

/**
 * The player-facing error for a refused relay answer (both relays, the
 * package and the music): the account gate (401 unauthenticated, 403
 * relay_forbidden and friends), the budgets (429) and upstream trouble.
 * @param {Response} res
 */
export async function relayProblem(res) {
  let error = {};
  try {
    error = (await res.json()).error ?? {};
  } catch {
    // not JSON
  }
  const code = error.code ?? '';
  if (res.status === 429) {
    return new Error(code === 'rate_limited' && error.message ? `${error.message.replace(/\.$/, '')}; or install the files yourself` : 'too many downloads from this network; try again in an hour or install the files yourself');
  }
  // The relay needs a signed-in account (401 unauthenticated) with the content_autoinstall flag or the admin role (403 relay_forbidden).
  if (res.status === 401) return new Error('sign in first: the one-click download is only for selected accounts; or install the files yourself with the steps below');
  if (res.status === 403) {
    if (code === 'relay_forbidden' || code === 'forbidden') return new Error('the one-click download is only for selected accounts; install the files yourself with the steps below');
    if (code === 'banned') return new Error('this account is banned');
    if (code === 'account_inactive') return new Error('your account is not active yet');
    if (code === 'ip_banned') return new Error('downloads are blocked from your network');
    return new Error('the one-click download is not allowed; install the files yourself with the steps below');
  }
  return new Error(error.message ?? `the server answered ${res.status}`);
}

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
  if (!res.ok || !res.body) throw await relayProblem(res);
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

/**
 * Whether the start screen shows the original content notice: nothing
 * installed yet and not dismissed (the choice is a synced setting).
 * @param {{ installed: boolean, registry: { get(group: string, key: string): any } | null }} o
 */
export function shouldShowNotice({ installed, registry }) {
  if (installed) return false;
  try {
    return registry?.get(...NOTICE_SETTING) !== true;
  } catch {
    return false;
  }
}

/** Remember that the player dismissed the notice. */
export function dismissNotice(registry) {
  try {
    registry?.set(...NOTICE_SETTING, true);
  } catch {
    // Without a registry the notice comes back next time.
  }
}

/**
 * Whether this player may use the one-click download: the server's verdict
 * `canUseContentRelay` of the signed-in account (docs/accounts-api.md 5.1:
 * active, the flag content_autoinstall or admin, the relay switched on), or
 * without it the flag or the admin role. The server checks again on the
 * download; this only decides what the game offers.
 * @param {{ role?: string, flags?: string[], canUseContentRelay?: boolean } | null} account
 */
export function canAutoInstall(account) {
  if (!account) return false;
  if (typeof account.canUseContentRelay === 'boolean') return account.canUseContentRelay;
  if (account.role === 'admin') return true;
  const flags = account.flags;
  if (Array.isArray(flags)) return flags.includes('content_autoinstall');
  return !!(flags && flags.content_autoinstall === true);
}

/** The notice shown with every download button. */
export const DOWNLOAD_NOTICE =
  "These are Electronic Arts' Red Alert files, which EA released as freeware in 2008. WebRA fetches OpenRA's ra-quickinstall.zip from OpenRA's community mirrors through webra.sherin.dev (passed through, never kept on the server) and stores it only on this device.";

/** The notice for the manual steps: what the files are and where they stay. */
export const LEGAL_NOTICE =
  "Red Alert belongs to Electronic Arts, who released it as freeware in 2008. WebRA does not host or distribute it: the mirrors are run by OpenRA's community and the Internet Archive. Your files are read in this browser and stored on this device only; nothing is uploaded.";
