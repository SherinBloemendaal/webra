// The original Red Alert music (scores.mix) from the freeware Red Alert CDs
// that Electronic Arts released in 2008.
//
// Everyone: download the Allied or the Soviet CD image (ISO) from the
// Internet Archive (FREEWARE_CDS, plain links) and drop or pick it in the
// game. The image is never read as a whole: content/iso.js reads its
// directory and content/install.js opens MAIN.MIX and INSTALL/REDALERT.MIX
// inside it by File.slice(), so the music, sounds and graphics install
// from a 650 MB file with a few dozen megabytes read.
//
// Selected accounts (the content_autoinstall flag, and admins): a one-click
// download through WebRA's server, which reads only scores.mix out of the
// disc image on the Internet Archive by HTTP range and streams it on without
// keeping a copy (apps/server/src/cdmusic.js). The game asks for it in
// SCORES_PIECE pieces, keeps each finished piece in the content store
// (store.js partials) so a cut off download goes on where it stopped,
// checks the whole file against SCORES_SHA256, and only then installs it
// like a picked scores.mix. A file that does not match is thrown away.

import { relayProblem, RelayLimitError } from './download.js';

export const SCORES_URL = '/api/content/ra-scores';
/** scores.mix on both freeware discs: its size and SHA-256 (the server pins the same). */
export const SCORES_BYTES = 64_171_360;
export const SCORES_SHA256 = '313ef2e4e9dfe33d0d282d078d9c545fe1aff4748375f062d2da2a96f93c0846';
/** Bytes per request (the server allows up to 8 MiB). */
export const SCORES_PIECE = 8 * 1024 * 1024;
/** The download's name among the store's unfinished downloads. */
export const SCORES_PARTIAL = 'ra-scores';
/** Tries per piece when the network fails (not when the server refuses; server errors: UNAVAILABLE_RETRIES). */
export const PIECE_TRIES = 3;

/**
 * The freeware CD images on the Internet Archive (EA's CD1_ALLIED_DISC.ISO
 * and CD2_SOVIET_DISC.ISO of 2008). Plain links: the player downloads one
 * and drops or picks it in the game. Either disc has the music.
 */
export const FREEWARE_CDS = Object.freeze([
  Object.freeze({
    label: 'Allied disc',
    bytes: 654_348_288,
    url: 'https://archive.org/download/command-conquer-red-alert_202309/Command%20%26%20Conquer%20Red%20Alert%20%5BCD1%5D.ISO',
  }),
  Object.freeze({
    label: 'Soviet disc',
    bytes: 677_396_480,
    url: 'https://archive.org/download/command-conquer-red-alert_202309/Command%20%26%20Conquer%20Red%20Alert%20%5BCD2%5D.ISO',
  }),
]);
/** EA's original 2008 download (RAR archives with the ISO inside), for reference. */
export const FREEWARE_RELEASE_PAGE = 'https://archive.org/details/official-cn-ctiberian-sun_202510';

/** The notice shown with the music button. */
export const MUSIC_NOTICE =
  "The music is not in that package: WebRA reads only scores.mix (the soundtrack) out of the freeware Red Alert CD images on the Internet Archive, through webra.sherin.dev (passed through, never kept on the server), checks it, and stores it only on this device.";

/** The size of piece `i`. */
export const pieceLength = (i) => Math.min(SCORES_PIECE, SCORES_BYTES - i * SCORES_PIECE);
export const PIECES = Math.ceil(SCORES_BYTES / SCORES_PIECE);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The player cancelled the download. */
export class CancelledError extends Error {
  constructor() {
    super('the download was cancelled; what was downloaded so far is kept for the next try');
    this.name = 'CancelledError';
  }
}

/** A refusal from the server that trying again will not change (401, 403, 416; 429 is a RelayLimitError). */
class Refused extends Error {}

/** The relay could not reach the archive (5xx): worth one more try per download at most. */
class Unavailable extends Error {}

/** Server errors retried per download (a click), in all: each costs the archive a round of requests. */
export const UNAVAILABLE_RETRIES = 1;

/**
 * Piece `i` of the file at `url` (`total` bytes, `piece` bytes per piece)
 * through a relay: exactly the asked range, or a readable error.
 */
async function fetchPiece(i, { url, total, piece, fetchImpl, signal, onBytes }) {
  const start = i * piece;
  const end = Math.min(total, start + piece) - 1;
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'X-WebRA-Content': '1', Range: `bytes=${start}-${end}` }, cache: 'no-store', signal });
  } catch (err) {
    if (signal?.aborted) throw new CancelledError();
    throw new Error(`the download could not start (${err.message ?? err})`);
  }
  if (res.status !== 206 || !res.body) {
    const problem = await relayProblem(res);
    // A used up budget (429) keeps its time to try again; no refusal is retried here.
    if (problem instanceof RelayLimitError) throw problem;
    if (res.status >= 400 && res.status < 500) throw new Refused(problem.message);
    throw res.status >= 500 ? new Unavailable(problem.message) : problem;
  }
  if (res.headers.get('Content-Range') !== `bytes ${start}-${end}/${total}`) {
    await res.body.cancel().catch(() => {});
    throw new Error('the server answered with another part of the file');
  }
  const out = new Uint8Array(end - start + 1);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.byteLength > out.length) {
        await reader.cancel().catch(() => {});
        throw new Error('the server sent more than asked');
      }
      out.set(value, got);
      got += value.byteLength;
      onBytes(value.byteLength);
    }
  } catch (err) {
    onBytes(-got);
    if (signal?.aborted) throw new CancelledError();
    throw err;
  }
  if (got !== out.length) {
    onBytes(-got);
    throw new Error(`the download stopped after ${got} of ${out.length} bytes`);
  }
  return out;
}

/**
 * Download a file through a relay in pieces, kept in `store` (partials
 * under `key`) as they arrive, so a cut off download goes on where it
 * stopped. Kept pieces of the right size are not asked for again (their
 * indexes are read, not their bytes). `check(i, bytes)` may refuse a piece
 * (it is not kept, and the download fails with its message); `onPiece(i,
 * bytes)` sees every piece, kept ones (read only when `onPiece` wants them,
 * `readKept`) and new ones. A dropped connection is tried again
 * (PIECE_TRIES per piece), a server error once per call
 * (UNAVAILABLE_RETRIES), a refusal (4xx, a used up budget) never.
 */
export async function downloadPieces({
  url,
  total,
  key,
  store,
  piece = SCORES_PIECE,
  check = () => null,
  onPiece = () => {},
  readKept = false,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  signal,
}) {
  const count = Math.ceil(total / piece);
  const lengthOf = (i) => Math.min(piece, total - i * piece);
  const have = new Set();
  if (readKept) {
    const kept = await store.partials(key);
    for (const [i, bytes] of kept) {
      if (Number.isInteger(i) && i >= 0 && i < count && bytes?.byteLength === lengthOf(i)) {
        onPiece(i, new Uint8Array(bytes));
        have.add(i);
      }
    }
    kept.clear();
  } else {
    // Only which pieces are there; a piece of the wrong size is replaced when it is downloaded again.
    const records = store.partialIndexes ? null : await store.partials(key);
    const indexes = records ? [...records.keys()] : await store.partialIndexes(key);
    for (const i of indexes) if (Number.isInteger(i) && i >= 0 && i < count) have.add(i);
  }
  let received = [...have].reduce((n, i) => n + lengthOf(i), 0);
  onProgress(received, total);
  const onBytes = (n) => {
    received += n;
    onProgress(received, total);
  };
  let unavailableLeft = UNAVAILABLE_RETRIES;
  for (let i = 0; i < count; i++) {
    if (have.has(i)) continue;
    let bytes = null;
    for (let attempt = 1; !bytes; attempt++) {
      if (signal?.aborted) throw new CancelledError();
      try {
        bytes = await fetchPiece(i, { url, total, piece, fetchImpl, signal, onBytes });
      } catch (err) {
        if (err instanceof CancelledError || err instanceof Refused || err instanceof RelayLimitError || attempt >= PIECE_TRIES) throw err;
        if (err instanceof Unavailable && unavailableLeft-- <= 0) throw err;
      }
    }
    const problem = await check(i, bytes);
    if (problem) {
      onBytes(-bytes.length);
      throw new Error(problem);
    }
    onPiece(i, bytes);
    await store.putPartial(key, i, bytes.buffer);
  }
}

/**
 * Download scores.mix through the relay, resuming from the pieces kept in
 * `store`. Returns a File named scores.mix whose SHA-256 is SCORES_SHA256;
 * throws with a readable message otherwise (CancelledError when `signal`
 * aborts). The kept pieces stay until `forgetScoresDownload` (after the
 * install) or until the file turns out wrong.
 * @param {{ store: { putPartial(k: string, i: number, b: ArrayBuffer): Promise<void>, partials(k: string): Promise<Map<number, ArrayBuffer>>, clearPartials(k: string): Promise<void> },
 *   onProgress?(received: number, total: number): void, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *   digest?(bytes: Uint8Array): Promise<ArrayBuffer>, expected?: string }} o
 *   expected: the SHA-256 (hex) to match; tests use their own synthetic bytes
 */
export async function downloadScores({
  store,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  signal,
  digest = (b) => globalThis.crypto.subtle.digest('SHA-256', b),
  expected = SCORES_SHA256,
}) {
  const out = new Uint8Array(SCORES_BYTES);
  await downloadPieces({
    url: SCORES_URL,
    total: SCORES_BYTES,
    key: SCORES_PARTIAL,
    store,
    readKept: true,
    onPiece: (i, bytes) => out.set(bytes, i * SCORES_PIECE),
    onProgress,
    fetchImpl,
    signal,
  });
  if (hex(await digest(out)) !== expected) {
    await store.clearPartials(SCORES_PARTIAL);
    throw new Error('the downloaded music does not match the freeware CDs (checksum), so it was thrown away; try again later');
  }
  return new File([out], 'scores.mix', { type: 'application/octet-stream' });
}

/** Forget the kept pieces (after the install, or to start over). */
export function forgetScoresDownload(store) {
  return store.clearPartials(SCORES_PARTIAL);
}
