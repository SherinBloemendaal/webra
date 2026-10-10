// VQA movies (js/content/vqa.js), the movie player (js/content/movies.js)
// and the mission view playing them (js/campaign/view.js). Every movie here
// is built in the test: no Electronic Arts file, and nothing made from one,
// is in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lcwDecode, looksLikeVqa, openVqa, VqaError, VQA_LIMITS } from '../js/content/vqa.js';
import { createMoviePlayer, isMovieName, movieKey, MOVIE_FILES, DECODE_PER_TICK } from '../js/content/movies.js';
import { imaDecodeNibble } from '../js/audio/aud.js';
import { MissionView } from '../js/campaign/view.js';
import { MissionFeed } from '../js/sim/proxy.js';
import { imaEncode, sineSamples } from './audio-fixtures.mjs';
import { buildVqa, lcwEncode, rng, vqaChunk } from './content-fixtures.mjs';
import { FakeElement, FakeEvent, installDom, settle, uninstallDom } from './dom-fixtures.mjs';

// ---- A small 8-bit movie --------------------------------------------------------------

const W = 8;
const H = 4;
const BLOCK = 8; // 4x2 blocks: 2 x 2 of them
/** Palette (6-bit RGB). */
const PAL = Uint8Array.from({ length: 768 }, (_, i) => [(i / 3) % 64, ((i / 3) * 3) % 64, ((i / 3) * 7) % 64][i % 3] | 0);
/** Codebook A: four entries of eight palette indexes; codebook B: other indexes. */
const CB_A = Uint8Array.from({ length: 4 * BLOCK }, (_, i) => i + 1);
const CB_B = Uint8Array.from({ length: 4 * BLOCK }, (_, i) => 100 + ((i * 5) % 32));
/** Vector pointers: low bytes of the four blocks, then high bytes (0x0f: one colour, the low byte). */
const VEC_0 = Uint8Array.from([0, 1, 3, 200, 0, 0, 0, 0x0f]);
const VEC_1 = Uint8Array.from([2, 1, 3, 7, 0, 0, 0, 0x0f]);
const SAMPLES = sineSamples(300, 440, 22050, 9000);
const IMA = imaEncode(SAMPLES);

/** The frame a decoder must produce (written out here, independent of vqa.js). */
function expectedFrame(cb, vec) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const b = Math.floor(x / 4) + Math.floor(y / 2) * 2;
      const lo = vec[b];
      const hi = vec[b + 4];
      const index = hi === 0x0f ? lo : cb[(hi * 256 + lo) * BLOCK + (y % 2) * 4 + (x % 4)];
      const o = (y * W + x) * 4;
      out[o] = PAL[index * 3] << 2;
      out[o + 1] = PAL[index * 3 + 1] << 2;
      out[o + 2] = PAL[index * 3 + 2] << 2;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Three frames: codebook A (CBFZ) and the palette; codebook B arrives in two CBPZ parts and applies from frame 2. */
function smallMovie({ audio = true, vpt = null } = {}) {
  const cbB = lcwEncode(CB_B);
  const half = Math.ceil(cbB.length / 2);
  const snd = (a, b) => (audio ? [vqaChunk('SND2', IMA.subarray(a, b))] : []);
  return buildVqa({
    width: W,
    height: H,
    cbParts: 2,
    extraHeader: [vqaChunk('CINF', new Uint8Array(6))],
    frames: [
      [...snd(0, 75), vqaChunk('VQFR', vqaChunk('CBFZ', lcwEncode(CB_A)), vqaChunk('CPL0', PAL), vqaChunk('CBPZ', cbB.subarray(0, half)), vpt ?? vqaChunk('VPTZ', lcwEncode(VEC_0)))],
      [...snd(75, 150), vqaChunk('VQFR', vqaChunk('CBPZ', cbB.subarray(half)), vqaChunk('VPT0', VEC_1))],
      [vqaChunk('VQFR', vqaChunk('VPT0', VEC_1))],
    ],
  });
}

test('LCW: absolute and relative copies, and data that overruns its output or its chunk throws', () => {
  const r = rng(5);
  const src = Uint8Array.from({ length: 2000 }, (_, i) => (i % 97 < 40 ? 7 : Math.floor(r() * 256)));
  const packed = lcwEncode(src);
  const out = new Uint8Array(src.length);
  assert.equal(lcwDecode(packed, 0, packed.length, out), src.length);
  assert.deepEqual(out, src);
  // Command 3 copies three bytes from offset 3: absolute is "from byte 3" (not written yet), relative is "3 back".
  const cmd3 = Uint8Array.from([0x83, 1, 2, 3, 0xc0, 3, 0, 0x80]);
  const rel = new Uint8Array(6);
  assert.equal(lcwDecode(cmd3, 0, cmd3.length, rel, true), 6);
  assert.deepEqual([...rel], [1, 2, 3, 1, 2, 3]);
  assert.throws(() => lcwDecode(cmd3, 0, cmd3.length, new Uint8Array(6)), VqaError);
  assert.throws(() => lcwDecode(packed, 0, packed.length, new Uint8Array(100)), /overruns its output/);
  assert.throws(() => lcwDecode(packed, 0, 50, out), /reads past the end/);
  assert.throws(() => lcwDecode(Uint8Array.from([0x00, 0x05, 0x80]), 0, 3, new Uint8Array(8)), /bad back reference/);
});

test('VQA: an 8-bit movie decodes to the right pixels, codebook parts apply a frame late, and the IMA sound track decodes', () => {
  const bytes = smallMovie();
  assert.ok(looksLikeVqa(bytes));
  const v = openVqa(bytes);
  assert.equal(v.width, W);
  assert.equal(v.height, H);
  assert.equal(v.frameRate, 15);
  assert.equal(v.frameCount, 3);
  assert.equal(v.hq, false);
  assert.equal(v.hasAudio, true);
  assert.deepEqual(v.nextFrame(), expectedFrame(CB_A, VEC_0));
  // Frame 1 completes codebook B, but it only applies from the next frame.
  assert.deepEqual(v.nextFrame(), expectedFrame(CB_A, VEC_1));
  assert.deepEqual(v.nextFrame(), expectedFrame(CB_B, VEC_1));
  assert.equal(v.nextFrame(), null, 'after the last frame');
  // Random access goes back to the start when it has to.
  assert.deepEqual(v.frame(0), expectedFrame(CB_A, VEC_0));
  assert.deepEqual(v.frame(2), expectedFrame(CB_B, VEC_1));
  // The single colour block: palette entry 200.
  const o = (2 * W + 4) * 4;
  assert.deepEqual([...v.frame(0).subarray(o, o + 4)], [PAL[600] << 2, PAL[601] << 2, PAL[602] << 2, 255]);

  const pcm = v.decodeAudio();
  assert.equal(pcm.sampleRate, 22050);
  assert.equal(pcm.channels, 1);
  assert.equal(pcm.data[0].length, 300);
  const state = { index: 0, sample: 0 };
  const want = [];
  for (const b of IMA) want.push(imaDecodeNibble(b & 15, state), imaDecodeNibble(b >> 4, state));
  assert.deepEqual(
    Array.from(pcm.data[0], (s) => Math.round(s * 32768)),
    want,
    'one IMA stream across the chunks (the decoder state carries over)',
  );
  // After the encoder's first steps have settled, the sound follows the sine.
  const err = Math.max(...Array.from(pcm.data[0].subarray(100), (s, i) => Math.abs(s * 32768 - SAMPLES[100 + i])));
  assert.ok(err < 1500, `close to the encoded sine (${err})`);
  assert.equal(openVqa(smallMovie({ audio: false })).decodeAudio(), null);
});

test('VQA: 15-bit movies (CBFZ with relative copies, VPTR block instructions)', () => {
  const r = rng(11);
  const colours = Array.from({ length: 3 * BLOCK }, () => Math.floor(r() * 0x8000));
  const packed = new Uint8Array(colours.length * 2);
  colours.forEach((c, i) => {
    packed[2 * i] = c & 255;
    packed[2 * i + 1] = c >> 8;
  });
  const u16s = (...v) => Uint8Array.from(v.flatMap((x) => [x & 255, x >> 8]));
  // Frame 0: block 1 at (0,0), skip (1,0), then block 2 twice for the second row.
  const f0 = new Uint8Array([...u16s(0x6000 | 1, 0x0000 | 1, 0xa000 | 2), 2]);
  // Frame 1: block 1, then the blocks listed in the next two bytes (2 and 0), then block 1.
  const f1 = new Uint8Array([...u16s(0x4000 | 1), 2, 0, ...u16s(0x6000 | 1)]);
  // Frame 2: a run of 4 blocks of entry 0 (count ((1 & 0x1f) + 1) * 2).
  const f2 = u16s(0x2000 | (1 << 8) | 0);
  const bytes = buildVqa({
    width: W,
    height: H,
    version: 3,
    flags: 0x10,
    channels: 0,
    frames: [
      [vqaChunk('VQFR', vqaChunk('CBFZ', Uint8Array.of(0), lcwEncode(packed, { copies: false })), vqaChunk('VPTR', f0))],
      [vqaChunk('VQFR', vqaChunk('VPRZ', lcwEncode(f1, { copies: false })))],
      [vqaChunk('VQFR', vqaChunk('VPTR', f2))],
    ],
  });
  const v = openVqa(bytes);
  assert.equal(v.hq, true);
  const rgb = (entry, px) => {
    const c = colours[entry * BLOCK + px];
    return [(c & 0x7c00) >> 7, (c & 0x3e0) >> 2, (c & 0x1f) << 3, 255];
  };
  const blockAt = (frame, bx, by) => {
    const out = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) out.push(...frame.subarray(((by * 2 + j) * W + bx * 4 + i) * 4, ((by * 2 + j) * W + bx * 4 + i) * 4 + 4));
    return out;
  };
  const entry = (e) => Array.from({ length: BLOCK }, (_, px) => rgb(e, px)).flat();
  const black = Array.from({ length: BLOCK }, () => [0, 0, 0, 255]).flat();
  let f = v.nextFrame();
  assert.deepEqual(blockAt(f, 0, 0), entry(1));
  assert.deepEqual(blockAt(f, 1, 0), black, 'a skipped block keeps what was there');
  assert.deepEqual(blockAt(f, 0, 1), entry(2));
  assert.deepEqual(blockAt(f, 1, 1), entry(2));
  f = v.nextFrame();
  assert.deepEqual([blockAt(f, 0, 0), blockAt(f, 1, 0), blockAt(f, 0, 1), blockAt(f, 1, 1)], [entry(1), entry(2), entry(0), entry(1)]);
  f = v.nextFrame();
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.deepEqual(blockAt(f, x, y), entry(0));
});

test('VQA: raw (SND0, 8-bit and 16-bit stereo) and Westwood ADPCM (SND1) sound', () => {
  const frame = [vqaChunk('VQFR', vqaChunk('CBF0', CB_A), vqaChunk('VPT0', VEC_0))];
  const raw8 = buildVqa({ bits: 8, frames: [[vqaChunk('SND0', Uint8Array.of(128, 255, 0)), ...frame]] });
  assert.deepEqual([...openVqa(raw8).decodeAudio().data[0]], [0, 127 / 128, -1]);
  // Stereo: the left half of the chunk, then the right half.
  const s16 = new Uint8Array(8);
  const dv = new DataView(s16.buffer);
  [1000, -1000, 5, 6].forEach((s, i) => dv.setInt16(i * 2, s, true));
  const stereo = openVqa(buildVqa({ channels: 2, bits: 16, sampleRate: 11025, frames: [[vqaChunk('SND0', s16), ...frame]] })).decodeAudio();
  assert.equal(stereo.channels, 2);
  assert.equal(stereo.sampleRate, 11025);
  assert.deepEqual([...stereo.data[0]].map((s) => s * 32768), [1000, -1000]);
  assert.deepEqual([...stereo.data[1]].map((s) => s * 32768), [5, 6]);
  // SND1: u16 samples out, u16 bytes in, then Westwood ADPCM (three raw samples, the last one three more times).
  const snd1 = Uint8Array.of(6, 0, 5, 0, 0x82, 10, 20, 30, 0xc2);
  const ws = openVqa(buildVqa({ bits: 8, frames: [[vqaChunk('SND1', snd1), ...frame]] })).decodeAudio();
  assert.deepEqual([...ws.data[0]].map((s) => s * 128 + 128), [10, 20, 30, 30, 30, 30]);
});

test('VQA: malformed files throw VqaError instead of hanging or allocating without bound', () => {
  const good = smallMovie();
  const bad = (bytes, re, limits) => assert.throws(() => openVqa(bytes, limits), (err) => err instanceof VqaError && re.test(err.message));
  const copy = () => good.slice();
  let b = copy();
  b[9] = 0x58; // WXQA
  bad(b, /not a VQA movie/);
  bad(good.subarray(0, good.length - 5), /runs past the end|truncated/);
  bad(good, /too large/, { ...VQA_LIMITS, maxBytes: 100 });
  bad(buildVqa({ width: 4096, height: 4, frames: [[]] }), /not supported/);
  bad(buildVqa({ width: 8, height: 4, blockWidth: 3, frames: [[]] }), /block size/);
  bad(buildVqa({ width: 10, height: 4, frames: [[]] }), /whole number of blocks/);
  bad(buildVqa({ frameRate: 0, frames: [[]] }), /frame rate/);
  bad(buildVqa({ version: 1, frames: [[]] }), /version 1/);
  // A frame index entry past the end of the file.
  b = copy();
  const finf = Buffer.from(b).indexOf('FINF');
  new DataView(b.buffer).setUint32(finf + 8 + 4, 0x3fffffff, true);
  bad(b, /outside the file/);
  // A chunk that claims more than the file has.
  b = copy();
  const vqfr = Buffer.from(b).indexOf('VQFR');
  new DataView(b.buffer).setUint32(vqfr + 4, 0x7fffffff, false);
  bad(b, /runs past the end/);
  // Decompression past the vector buffer, and pointers outside the codebook, throw when the frame is decoded.
  assert.throws(() => openVqa(smallMovie({ vpt: vqaChunk('VPTZ', lcwEncode(new Uint8Array(100))) })).nextFrame(), /overruns its output/);
  assert.throws(() => openVqa(smallMovie({ vpt: vqaChunk('VPT0', Uint8Array.of(0, 0, 0, 0, 0x20, 0, 0, 0)) })).nextFrame(), /outside the codebook/);
  assert.throws(() => openVqa(smallMovie({ vpt: vqaChunk('XXXX', new Uint8Array(2)) })).nextFrame(), /unknown frame chunk/);
  assert.throws(() => openVqa(good, { ...VQA_LIMITS, maxAudioSeconds: 0.0001 }).decodeAudio(), /too long/);
  // A sound track much longer than the pictures is refused before anything is allocated:
  // SND1 chunks of 4 bytes that each claim 65535 samples.
  const greedy = buildVqa({
    width: W,
    height: H,
    frames: [[...Array.from({ length: 8 }, () => vqaChunk('SND1', Uint8Array.of(0xff, 0xff, 0, 0))), vqaChunk('VQFR', vqaChunk('VPT0', VEC_1))]],
  });
  assert.throws(() => openVqa(greedy).decodeAudio(), /too long/);
  // Random damage: every outcome is a decoded movie or a VqaError, never another error or a hang.
  const r = rng(9);
  for (let n = 0; n < 400; n++) {
    b = copy();
    for (let k = 0; k < 1 + Math.floor(r() * 6); k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    try {
      const v = openVqa(b);
      while (v.nextFrame());
      v.decodeAudio();
    } catch (err) {
      assert.ok(err instanceof VqaError, `damaged movie ${n}: ${err.stack}`);
    }
  }
});

// ---- The movie player ----------------------------------------------------------------

/** A 2D context stand-in: records what was drawn. */
function fakeCanvas() {
  const drawn = [];
  const original = FakeElement.prototype.getContext;
  FakeElement.prototype.getContext = () => ({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image) => drawn.push(image.data.slice()),
  });
  return { drawn, restore: () => (FakeElement.prototype.getContext = original) };
}

function fakeAudio() {
  const ctx = {
    currentTime: 0,
    started: [],
    stopped: 0,
    createBuffer: (channels, length, sampleRate) => ({ channels, length, sampleRate, duration: length / sampleRate, data: [], copyToChannel(d, ch) { this.data[ch] = d; } }),
    createBufferSource: () => ({
      connect: (to) => (ctx.connectedTo = to),
      disconnect() {},
      start: (at) => ctx.started.push(at),
      stop: () => ctx.stopped++,
    }),
  };
  return ctx;
}

function playerRig({ movies = { 'landing.vqa': smallMovie() }, audio = null } = {}) {
  const frames = [];
  let t = 0;
  const content = {
    hasMovie: (n) => n in movies,
    movieBytes: async (n) => movies[n] ?? null,
  };
  const player = createMoviePlayer({
    content,
    audio: () => (audio ? { context: audio, destination: 'speakers' } : null),
    raf: (fn) => frames.push(fn),
    cancelRaf: () => {},
    now: () => t,
  });
  /** Run the queued animation frames at `ms`. */
  const step = (ms) => {
    t = ms;
    if (audio) audio.currentTime = ms / 1000 + 0.05;
    for (const fn of frames.splice(0)) fn(ms);
  };
  return { player, step };
}

test('movie player: plays a movie full screen at its frame rate, with sound, and ends', async () => {
  const doc = installDom({ windowEvents: true });
  const canvas = fakeCanvas();
  try {
    const field = doc.createElement('main');
    doc.body.append(field);
    const audio = fakeAudio();
    const { player, step } = playerRig({ audio });
    assert.equal(player.has('LANDING.VQA'), true);
    assert.equal(player.has('prolog.vqa'), false);
    assert.equal(await player.play('prolog.vqa', field), 'missing');
    const done = player.play('landing.vqa', field);
    await settle();
    const overlay = field.querySelector('.movie-overlay');
    assert.ok(overlay, 'the overlay is up');
    assert.equal(overlay.getAttribute('role'), 'dialog');
    assert.equal(overlay.getAttribute('aria-label'), 'Movie: landing');
    assert.ok(overlay.querySelector('canvas'));
    assert.match(overlay.textContent, /Esc, Space or Enter/);
    assert.equal(canvas.drawn.length, 1, 'the first frame shows at once');
    assert.equal(audio.started.length, 1, 'the sound track started');
    assert.equal(audio.connectedTo, 'speakers');
    step(70); // frame 1 is due at 1/15 s
    assert.equal(canvas.drawn.length, 2);
    assert.deepEqual(canvas.drawn[1], expectedFrame(CB_A, VEC_1));
    step(1000);
    assert.deepEqual(canvas.drawn.at(-1), expectedFrame(CB_B, VEC_1));
    assert.equal(await done, 'played');
    assert.equal(field.querySelector('.movie-overlay'), null, 'the overlay is gone');
    assert.equal(player.playing, false);
  } finally {
    canvas.restore();
    uninstallDom();
  }
});

test('movie player: Esc, a click or stop() skip; a movie that does not decode fails; it never decodes too much per frame', async () => {
  const doc = installDom({ windowEvents: true });
  const canvas = fakeCanvas();
  try {
    const field = doc.createElement('main');
    doc.body.append(field);
    const long = buildVqa({ frames: Array.from({ length: 40 }, () => [vqaChunk('VQFR', vqaChunk('CBF0', CB_A), vqaChunk('VPT0', VEC_0))]) });
    const { player, step } = playerRig({ movies: { 'landing.vqa': smallMovie(), 'long.vqa': long, 'broken.vqa': new Uint8Array(64) } });
    let done = player.play('landing.vqa', field);
    await settle();
    const key = new FakeEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(key);
    assert.equal(await done, 'skipped');
    assert.ok(key.defaultPrevented, 'the key does not reach the game');
    assert.equal(field.querySelector('.movie-overlay'), null);

    done = player.play('landing.vqa', field);
    await settle();
    field.querySelector('.movie-overlay').click();
    assert.equal(await done, 'skipped');

    done = player.play('long.vqa', field);
    await settle();
    const before = canvas.drawn.length;
    step(2000); // 30 frames are due: only a few are decoded in one animation frame
    assert.equal(canvas.drawn.length, before + 1);
    // Another movie replaces this one.
    const next = player.play('landing.vqa', field);
    assert.equal(await done, 'skipped');
    await settle();
    player.stop();
    assert.equal(await next, 'skipped');

    assert.equal(await player.play('broken.vqa', field), 'failed');
    assert.equal(field.querySelector('.movie-overlay'), null);
    assert.ok(DECODE_PER_TICK >= 1 && DECODE_PER_TICK < 30);
  } finally {
    canvas.restore();
    uninstallDom();
  }
});

test('movie names: the OpenRA movie packages, file names as the scripts give them', () => {
  assert.ok(MOVIE_FILES.has('landing.vqa') && MOVIE_FILES.has('sovtstar.vqa') && MOVIE_FILES.has('ally10b.vqa'));
  assert.equal(MOVIE_FILES.size, 94);
  assert.equal(movieKey('LANDING.VQA'), 'landing.vqa');
  assert.equal(movieKey('movies/ally1.vqa'), 'ally1.vqa');
  assert.equal(movieKey('prolog'), 'prolog.vqa');
  assert.ok(isMovieName('x.VQA') && !isMovieName('x.aud'));
});

// ---- The mission view -----------------------------------------------------------------

function missionView(field, movies) {
  const hud = field.ownerDocument.createElement('div');
  field.append(hud);
  return new MissionView({
    field,
    hudButtons: hud,
    feed: new MissionFeed(),
    audio: null,
    movies,
    centerOn() {},
    ping() {},
    toScreen: () => null,
    pxPerCell: 24,
    tickMs: 40,
    onRestart() {},
    onLeave() {},
  });
}

test('mission view: plays an installed movie, and shows the card when it is missing or fails', async () => {
  const doc = installDom({ windowEvents: true });
  try {
    const field = doc.createElement('main');
    doc.body.append(field);
    const calls = [];
    let finish = null;
    const movies = {
      has: (f) => f === 'landing.vqa' || f === 'broken.vqa',
      play: (f, parent) => {
        calls.push([f, parent]);
        return new Promise((resolve) => (finish = resolve));
      },
      stop: () => finish('skipped'),
    };
    const view = missionView(field, movies);
    view.movie('landing.vqa');
    assert.deepEqual(calls, [['landing.vqa', field]]);
    assert.equal(field.querySelector('.mission-card'), null, 'no card while the movie plays');
    assert.ok(view.card, 'the movie can be closed like a card');
    finish('played');
    await settle();
    assert.equal(view.card, null);
    assert.equal(field.querySelector('.mission-card'), null);

    // A movie that fails falls back to the card.
    view.movie('broken.vqa');
    finish('failed');
    await settle();
    assert.match(field.querySelector('.mission-card').textContent, /Movie: broken/);
    view.card.close();

    // A movie the player does not have: the card, the player is not asked.
    view.movie('prolog.vqa');
    assert.equal(calls.length, 2);
    assert.match(field.querySelector('.mission-card').textContent, /Movie: prolog/);
    // The next movie closes the card and plays.
    view.movie('landing.vqa');
    assert.equal(field.querySelector('.mission-card'), null);
    // And a movie that replaces a playing one stops it without a card for the old one.
    const first = finish;
    view.movie('landing.vqa');
    first('skipped');
    await settle();
    assert.equal(field.querySelector('.mission-card'), null);
    assert.ok(view.card, 'the new movie is still on');

    // Without a player: the card, as before.
    const plain = missionView(field, null);
    plain.movie('landing.vqa');
    assert.match(field.textContent, /Movie: landing/);
    plain.card.close();
    view.card.close();
    await settle();
    assert.equal(view.card, null);
  } finally {
    uninstallDom();
  }
});
