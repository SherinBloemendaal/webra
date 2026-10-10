// The freeware CD path (js/content/iso.js, cdmusic.js and the CD image
// support of install.js): ISO 9660 reading by slices, installing from a CD
// image, and the resumable, checked music download through the relay. Every
// image, archive and sound here is synthetic (content-fixtures.mjs,
// audio-fixtures.mjs): no Electronic Arts file, and nothing made from one,
// is in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IsoImage, IsoError, isoName, SECTOR } from '../js/content/iso.js';
import { blobSource, bytesSource, MixArchive, mixHash } from '../js/audio/mix.js';
import { installContent, MAX_FILE_BYTES } from '../js/content/install.js';
import { MemoryStore } from '../js/content/store.js';
import { RelayLimitError } from '../js/content/download.js';
import { MUSIC } from '../js/audio/catalog.js';
import {
  downloadScores,
  forgetScoresDownload,
  CancelledError,
  SCORES_BYTES,
  SCORES_PIECE,
  SCORES_PARTIAL,
  SCORES_URL,
  PIECES,
  FREEWARE_CDS,
} from '../js/content/cdmusic.js';
import { buildMix, imaAud, sineSamples } from './audio-fixtures.mjs';
import { buildIso, buildVqa, vqaChunk } from './content-fixtures.mjs';
import { archiveFile, downloadMovieArchive, forgetMovieDownload, keptMovieBytes, MOVIE_ARCHIVES, MOVIES_BYTES } from '../js/content/cdmovies.js';
import { ALLIED_MOVIES } from '../js/content/movies.js';

/** A File stand-in that counts what is read of it (slices only; never the whole). */
function countingFile(bytes, name) {
  const blob = new Blob([bytes]);
  const file = {
    name,
    size: blob.size,
    read: 0,
    slice(a, b) {
      file.read += Math.min(b, blob.size) - a;
      return blob.slice(a, b);
    },
    arrayBuffer() {
      throw new Error('the whole image must never be loaded');
    },
  };
  return file;
}

test('iso: names, directories over several sectors, subdirectories, any case', async () => {
  assert.equal(isoName('MAIN.MIX;1'), 'MAIN.MIX');
  assert.equal(isoName('README.;1'), 'README');
  const main = new Uint8Array(5000).map((_, i) => i & 255);
  const red = new Uint8Array(300).fill(9);
  const img = buildIso({ 'MAIN.MIX': main, 'INSTALL/REDALERT.MIX': red }, { fillDirs: 80 });
  const iso = await IsoImage.open(bytesSource(img));
  assert.ok(iso.root.size > SECTOR, 'the root spans more than one sector');
  const root = await iso.list(iso.root);
  assert.ok(root.some((r) => r.name === 'INSTALL' && r.dir));
  assert.equal(root.filter((r) => r.name.startsWith('FILLER')).length, 80);
  const m = await iso.fileSource('main.mix');
  assert.equal(m.size, 5000);
  assert.deepEqual(await m.read(4990, 10), main.subarray(4990));
  const r = await iso.fileSource('INSTALL\\redalert.mix');
  assert.deepEqual(await r.read(0, 300), red);
  assert.equal(await iso.find('NOPE.MIX'), null);
  assert.equal(await iso.find('INSTALL'), null, 'a directory is not a file');
  assert.equal(await iso.find('MAIN.MIX/X'), null);
  assert.equal(await iso.find(''), null);
});

test('iso: not an image, truncated images and broken records are IsoError', async () => {
  await assert.rejects(IsoImage.open(bytesSource(new Uint8Array(100))), IsoError);
  await assert.rejects(IsoImage.open(bytesSource(new Uint8Array(40000))), /no ISO 9660 volume/);
  const img = buildIso({ 'MAIN.MIX': new Uint8Array(6000) });
  // Cut off inside MAIN.MIX: the directory still reads, the file is outside the image.
  const cut = img.subarray(0, img.length - 2048);
  const iso = await IsoImage.open(bytesSource(cut));
  await assert.rejects(iso.find('MAIN.MIX'), /outside the image/);
  // A record that claims more than the directory holds.
  const bad = img.slice();
  const rootAt = new DataView(bad.buffer).getUint32(16 * SECTOR + 156 + 2, true) * SECTOR;
  bad[rootAt + 34 + 34 + 32] = 200; // a name longer than its record
  const badIso = await IsoImage.open(bytesSource(bad));
  await assert.rejects(badIso.list(badIso.root), /bad directory record/);
  // The last record of a root's first sector grown so it would cross into the next sector.
  const crossing = buildIso({ 'MAIN.MIX': new Uint8Array(10) }, { fillDirs: 80 });
  const at = new DataView(crossing.buffer).getUint32(16 * SECTOR + 156 + 2, true) * SECTOR;
  let last = 0;
  for (let o = 0; o < SECTOR && crossing[at + o]; o += crossing[at + o]) last = o;
  crossing[at + last] = SECTOR - last + 2;
  const crossingIso = await IsoImage.open(bytesSource(crossing));
  await assert.rejects(crossingIso.list(crossingIso.root), /bad directory record/);
});

test('install: a freeware CD image installs music, sounds and voices by slices, never the whole image', async () => {
  const track = imaAud(sineSamples(2000));
  const effect = imaAud(sineSamples(500, 880));
  const scores = buildMix([{ name: MUSIC[0].file, data: track }, { name: MUSIC[1].file, data: track }]);
  const main = buildMix([
    { name: 'scores.mix', data: scores },
    { name: 'sounds.mix', data: buildMix([{ name: 'cannon1.aud', data: effect }]) },
    { name: 'movies1.mix', data: new Uint8Array(4096) },
  ]);
  const image = buildIso({ 'MAIN.MIX': main, 'INSTALL/REDALERT.MIX': buildMix([{ name: 'speech.mix', data: buildMix([{ name: 'abldgin1.aud', data: effect }]) }]) }, { padTo: 32 * 1024 * 1024 });
  const file = countingFile(image, 'CD1_ALLIED_DISC.ISO');
  const store = new MemoryStore();
  const r = await installContent([file], store);
  assert.equal(r.byCategory.music, 2, JSON.stringify(r));
  assert.equal(r.added, 4, JSON.stringify(r));
  assert.equal(r.byCategory.announcer, 1, 'INSTALL/REDALERT.MIX is read too');
  assert.ok(r.archives.includes('cd1_allied_disc.iso/main.mix/scores.mix'), r.archives.join());
  assert.ok((await store.names()).includes(MUSIC[0].file));
  assert.ok(file.read < main.length * 3 && file.read < image.length / 8, `read ${file.read} of ${image.length}`);
});

test('install: an image without Red Alert archives says so', async () => {
  const r = await installContent([countingFile(buildIso({ 'README.TXT': new Uint8Array(10) }), 'other.iso')], new MemoryStore());
  assert.equal(r.added, 0);
  assert.match(r.errors[0], /other\.iso: no MAIN\.MIX/);
  const r2 = await installContent([new File([new Uint8Array(50000)], 'junk.iso')], new MemoryStore());
  assert.match(r2.errors[0], /junk\.iso: not a CD image/);
});

test('install: an entry or a loose file larger than its limit is reported, never read', async () => {
  const claimed = MAX_FILE_BYTES.music + 1;
  // A Red Alert MIX index (flags, count, data size, one entry) claiming a huge track; the data is never there.
  const head = new Uint8Array(4 + 6 + 12);
  const dv = new DataView(head.buffer);
  dv.setUint16(4, 1, true);
  dv.setUint32(6, claimed, true);
  dv.setUint32(10, mixHash(MUSIC[0].file), true);
  dv.setUint32(14, 0, true);
  dv.setUint32(18, claimed, true);
  const reads = [];
  const mix = {
    name: 'scores.mix',
    size: head.length + claimed,
    slice(a, b) {
      reads.push(b - a);
      assert.ok(b - a <= 64 * 1024, `a read of ${b - a} bytes`);
      return { arrayBuffer: async () => head.slice(a, b).buffer };
    },
  };
  const loose = {
    name: MUSIC[1].file,
    size: claimed,
    arrayBuffer() {
      throw new Error('an oversized loose file must not be read');
    },
  };
  const r = await installContent([mix, loose], new MemoryStore());
  assert.equal(r.added, 0);
  assert.ok(r.errors.some((e) => e.startsWith(`${MUSIC[0].file} (in scores.mix): too large (${claimed} bytes`)), r.errors.join('; '));
  assert.ok(r.errors.some((e) => e.startsWith(`${MUSIC[1].file} (in ${MUSIC[1].file}): too large`)), r.errors.join('; '));
  assert.equal(r.errors.filter((e) => /too large/.test(e)).length, 2);
  assert.ok(reads.every((n) => n <= 64));
  assert.ok(MAX_FILE_BYTES.other < MAX_FILE_BYTES.music);
});

// ---- The relay download --------------------------------------------------------------

/** Synthetic stand-in for scores.mix (a pattern, not the real file) and its hash. */
const FAKE = (() => {
  const b = new Uint8Array(SCORES_BYTES);
  for (let i = 0; i < b.length; i += 4096) b[i] = (i / 4096) & 255;
  return b;
})();
const FAKE_SHA = createHash('sha256').update(FAKE).digest('hex');

/** The relay: answers the asked range of FAKE; `hook(piece, attempt)` may return a Response or throw instead. */
function relay(hook = () => null, calls = []) {
  const tries = new Map();
  return async (url, init) => {
    calls.push({ url, init });
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const piece = start / SCORES_PIECE;
    const attempt = (tries.get(piece) ?? 0) + 1;
    tries.set(piece, attempt);
    const special = await hook(piece, attempt, init);
    if (special) return special;
    return new Response(FAKE.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${SCORES_BYTES}` } });
  };
}

test('music download: pieces with Range through the relay, kept as they come, checked, then forgotten', async () => {
  const store = new MemoryStore();
  const calls = [];
  const seen = [];
  const file = await downloadScores({ store, fetchImpl: relay(undefined, calls), expected: FAKE_SHA, onProgress: (n, t) => seen.push([n, t]) });
  assert.equal(file.name, 'scores.mix');
  assert.equal(file.size, SCORES_BYTES);
  assert.equal(calls.length, PIECES);
  for (const [i, c] of calls.entries()) {
    assert.equal(c.url, SCORES_URL);
    assert.equal(c.init.headers['X-WebRA-Content'], '1');
    assert.equal(c.init.headers.Range, `bytes=${i * SCORES_PIECE}-${Math.min(SCORES_BYTES, (i + 1) * SCORES_PIECE) - 1}`);
    assert.equal(c.init.cache, 'no-store');
  }
  assert.deepEqual(seen.at(-1), [SCORES_BYTES, SCORES_BYTES]);
  assert.equal((await store.partials(SCORES_PARTIAL)).size, PIECES, 'kept until installed');
  assert.deepEqual((await store.names()), [], 'pieces are not content');
  await forgetScoresDownload(store);
  assert.equal((await store.partials(SCORES_PARTIAL)).size, 0);
  assert.equal(SCORES_BYTES, 64_171_360);
  assert.equal(FREEWARE_CDS.length, 2);
  for (const cd of FREEWARE_CDS) assert.match(cd.url, /^https:\/\/archive\.org\/download\/command-conquer-red-alert_202309\/.+\.ISO$/);
});

test('music download: a failure keeps the finished pieces; the next try asks only for the rest', async () => {
  const store = new MemoryStore();
  const down = relay((piece) => (piece === 3 ? new Response(JSON.stringify({ error: { message: 'archive down' } }), { status: 502 }) : null));
  await assert.rejects(downloadScores({ store, fetchImpl: down, expected: FAKE_SHA }), /archive down/);
  assert.deepEqual([...(await store.partials(SCORES_PARTIAL)).keys()].sort(), [0, 1, 2]);
  const calls = [];
  const file = await downloadScores({ store, fetchImpl: relay(undefined, calls), expected: FAKE_SHA });
  assert.deepEqual(
    calls.map((c) => c.init.headers.Range.split('=')[1].split('-')[0] / SCORES_PIECE),
    Array.from({ length: PIECES - 3 }, (_, i) => i + 3),
  );
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()).subarray(0, 4096 * 3), FAKE.subarray(0, 4096 * 3));
});

test('music download: a 502 from the relay is retried once per click, not per piece', async () => {
  const calls = [];
  const down = relay(() => new Response(JSON.stringify({ error: { code: 'unavailable', message: 'archive down' } }), { status: 502 }), calls);
  await assert.rejects(downloadScores({ store: new MemoryStore(), fetchImpl: down, expected: FAKE_SHA }), /archive down/);
  assert.equal(calls.length, 2, 'the first try and one retry');
  // One transient 502 on one piece: the download still completes, and a second one ends it.
  let bad = 2;
  const calls2 = [];
  const twice = relay((piece) => (piece === 4 && bad-- > 0 ? new Response('{}', { status: 502 }) : null), calls2);
  await assert.rejects(downloadScores({ store: new MemoryStore(), fetchImpl: twice, expected: FAKE_SHA }), /502/);
  let once = 1;
  const file = await downloadScores({ store: new MemoryStore(), fetchImpl: relay((piece) => (piece === 4 && once-- > 0 ? new Response('{}', { status: 502 }) : null)), expected: FAKE_SHA });
  assert.equal(file.size, SCORES_BYTES);
});

test('music download: a dropped connection is retried; a refusal is not', async () => {
  const flaky = relay((piece, attempt) => {
    if (piece === 1 && attempt === 1) throw new TypeError('network error');
    if (piece === 2 && attempt === 1) return new Response(FAKE.slice(0, 10), { status: 206, headers: { 'Content-Range': `bytes ${2 * SCORES_PIECE}-${3 * SCORES_PIECE - 1}/${SCORES_BYTES}` } });
    return null;
  });
  const file = await downloadScores({ store: new MemoryStore(), fetchImpl: flaky, expected: FAKE_SHA });
  assert.equal(file.size, SCORES_BYTES);
  for (const [status, code, re] of [
    [403, 'relay_forbidden', /selected accounts/],
    [401, 'unauthenticated', /sign in first/],
    [429, 'rate_limited', /downloaded the music too often/],
  ]) {
    const calls = [];
    const refuse = relay(() => new Response(JSON.stringify({ error: { code, message: 'This account downloaded the music too often today.', retryAfter: 3600 } }), { status }), calls);
    await assert.rejects(downloadScores({ store: new MemoryStore(), fetchImpl: refuse, expected: FAKE_SHA }), (e) => {
      assert.match(e.message, re);
      // A used up budget keeps its time to try again (the dialog holds the button until then).
      assert.equal(e instanceof RelayLimitError, status === 429);
      return true;
    });
    assert.equal(calls.length, 1, `${status} is not retried`);
  }
  // Another part of the file than asked for is refused.
  const wrong = relay(() => new Response(new Uint8Array(4), { status: 206, headers: { 'Content-Range': `bytes 0-3/${SCORES_BYTES}` } }));
  await assert.rejects(downloadScores({ store: new MemoryStore(), fetchImpl: wrong, expected: FAKE_SHA }), /another part/);
});

test('music download: Cancel stops it and keeps what came; a wrong checksum throws everything away', async () => {
  const store = new MemoryStore();
  const ctl = new AbortController();
  const slow = relay((piece, attempt, init) => {
    if (piece !== 2) return null;
    ctl.abort();
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
  await assert.rejects(downloadScores({ store, fetchImpl: slow, signal: ctl.signal, expected: FAKE_SHA }), CancelledError);
  assert.equal((await store.partials(SCORES_PARTIAL)).size, 2);
  // A kept piece of the wrong size is ignored and asked for again.
  await store.putPartial(SCORES_PARTIAL, 2, new ArrayBuffer(5));
  await assert.rejects(downloadScores({ store, fetchImpl: relay(), expected: 'f'.repeat(64) }), /does not match the freeware CDs/);
  assert.equal((await store.partials(SCORES_PARTIAL)).size, 0, 'a wrong file is not kept');
});

test('the real pin is the SHA-256 the server pins too', async () => {
  const { SCORES_SHA256 } = await import('../js/content/cdmusic.js');
  const server = await import('../../server/src/cdmusic.js');
  assert.equal(SCORES_SHA256, server.SCORES_SHA256);
  assert.equal(SCORES_BYTES, server.SCORES_BYTES);
  assert.ok(SCORES_PIECE <= server.SCORES_MAX_RANGE);
  assert.match(SCORES_SHA256, /^[0-9a-f]{64}$/);
  // The scores.mix reader copes with an index like the real one (an RA archive of tracks).
  const mix = await MixArchive.open(blobSource(new Blob([buildMix([{ name: MUSIC[0].file, data: new Uint8Array(32) }])])));
  assert.ok(mix.has(MUSIC[0].file));
});

// ---- Mission movies: pieces checked against their pins, kept, installed piece by piece ----

function tinyMovie(seed = 1) {
  const codebook = Uint8Array.from({ length: 32 }, (_, i) => (i * seed) & 255);
  return buildVqa({ frames: [[vqaChunk('VQFR', vqaChunk('CBF0', codebook), vqaChunk('CPL0', new Uint8Array(768)), vqaChunk('VPT0', Uint8Array.of(0, 1, 2, 3, 0, 0, 0, 0)))]] });
}

/** A synthetic movies1.mix, its pins for `piece`-byte pieces, and a relay serving it (with `hook(piece, attempt)`). */
function movieArchive(piece = 512) {
  const bytes = buildMix([
    { name: ALLIED_MOVIES[0], data: tinyMovie(1) },
    { name: ALLIED_MOVIES[1], data: tinyMovie(3) },
  ]);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const pieces = [];
  for (let at = 0; at < bytes.length; at += piece) pieces.push(sha(bytes.subarray(at, at + piece)));
  const archive = { ...MOVIE_ARCHIVES[0], bytes: bytes.length, pieces };
  const calls = [];
  const fetchFor = (hook = () => null) => async (url, init) => {
    calls.push({ url, init });
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(m[1]);
    const end = Number(m[2]);
    const special = await hook(start / piece, init);
    if (special) return special;
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  };
  return { bytes, archive, calls, fetchFor, piece };
}

test('movie archives: the pins cover both freeware discs, every piece of both archives', () => {
  assert.deepEqual(MOVIE_ARCHIVES.map((a) => [a.id, a.name, a.url]), [
    ['allied', 'movies1.mix', '/api/content/ra-movies/allied'],
    ['soviet', 'movies2.mix', '/api/content/ra-movies/soviet'],
  ]);
  for (const a of MOVIE_ARCHIVES) {
    assert.equal(a.pieces.length, Math.ceil(a.bytes / SCORES_PIECE), a.name);
    for (const h of [a.sha256, ...a.pieces]) assert.match(h, /^[0-9a-f]{64}$/);
  }
  assert.equal(MOVIES_BYTES, 369_362_336 + 415_334_456);
});

test('the movie pins match the server', async () => {
  const server = await import('../../server/src/cdmusic.js');
  assert.equal(server.MOVIES.allied.bytes, MOVIE_ARCHIVES[0].bytes);
  assert.equal(server.MOVIES.soviet.bytes, MOVIE_ARCHIVES[1].bytes);
});

test('movie download: checked pieces kept as they come, installed from the store piece by piece, then forgotten', async () => {
  const { bytes, archive, calls, fetchFor, piece } = movieArchive();
  const store = new MemoryStore();
  const file = await downloadMovieArchive({ archive, store, fetchImpl: fetchFor(), piece });
  assert.equal(calls.length, Math.ceil(bytes.length / piece));
  assert.equal(calls[0].url, '/api/content/ra-movies/allied');
  assert.equal(await keptMovieBytes(store, archive, piece), bytes.length);
  assert.equal(file.size, bytes.length);
  assert.equal(file.name, 'movies1.mix');
  const r = await installContent([file], store);
  assert.deepEqual(r.movies, [ALLIED_MOVIES[0], ALLIED_MOVIES[1]].sort());
  await forgetMovieDownload(store, archive);
  assert.equal(await keptMovieBytes(store, archive, piece), 0);
});

test('movie download: a piece that does not match its pin is not kept; a cut off download resumes', async () => {
  const { archive, fetchFor, piece } = movieArchive();
  const store = new MemoryStore();
  const evil = fetchFor((i) => (i === 2 ? new Response(new Uint8Array(piece).fill(9), { status: 206, headers: { 'Content-Range': `bytes ${2 * piece}-${3 * piece - 1}/${archive.bytes}` } }) : null));
  await assert.rejects(downloadMovieArchive({ archive, store, fetchImpl: evil, piece }), /part 3 of movies1\.mix does not match the freeware CDs/);
  assert.deepEqual((await store.partialIndexes(archive.partial)).sort(), [0, 1], 'only checked pieces are kept');
  const again = movieArchive();
  await downloadMovieArchive({ archive, store, fetchImpl: again.fetchFor(), piece });
  assert.equal(again.calls[0].init.headers.Range, `bytes=${2 * piece}-${3 * piece - 1}`, 'goes on where it stopped');
  // A 429 is a RelayLimitError and is not retried.
  const limited = movieArchive();
  await assert.rejects(
    downloadMovieArchive({
      archive,
      store: new MemoryStore(),
      piece,
      fetchImpl: limited.fetchFor(() => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'This account downloaded the movies too often today.', retryAfter: 60 } }), { status: 429 })),
    }),
    (e) => e instanceof RelayLimitError,
  );
  assert.equal(limited.calls.length, 1);
});

test('movie download: an archive missing a piece fails the read instead of installing garbage', async () => {
  const { archive, fetchFor, piece } = movieArchive();
  const store = new MemoryStore();
  const file = await downloadMovieArchive({ archive, store, fetchImpl: fetchFor(), piece });
  await store.clearPartials(archive.partial);
  await store.putPartial(archive.partial, 0, new ArrayBuffer(3));
  await assert.rejects(file.slice(0, 10).arrayBuffer(), /not complete on this device/);
  assert.equal(archiveFile(store, archive, piece).size, archive.bytes);
});
