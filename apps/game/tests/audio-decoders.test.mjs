// Decoders for the player's own Red Alert files (js/audio): Westwood MIX
// archives (plain and with an encrypted index), Blowfish and the RSA key step,
// and .aud sounds (IMA ADPCM and Westwood ADPCM). All fixtures are generated
// here (audio-fixtures.mjs); no Electronic Arts files are involved.
//   node --test apps/game/tests/audio-decoders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blowfish, piWords } from '../js/audio/blowfish.js';
import { decryptKeySource, westwoodPublicKey, parseKeyInteger, modPow } from '../js/audio/mixkey.js';
import { MixArchive, MixError, mixHash, bytesSource, blobSource } from '../js/audio/mix.js';
import { decodeAud, imaDecodeNibble, wsDecodeChunk, looksLikeAud, AudError } from '../js/audio/aud.js';
import { sineSamples, imaEncode, imaAud, wsAud, audFile, buildMix, buildEncryptedMix, testRsaKey, encryptKeySource } from './audio-fixtures.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const fromHex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));

// ---- Blowfish and the key ------------------------------------------------------

test('pi digits seed the Blowfish tables', () => {
  const w = piWords(18 + 1024);
  assert.equal(w[0], 0x243f6a88, 'P1');
  assert.equal(w[17], 0x8979fb1b, 'P18');
  assert.equal(w[18], 0xd1310ba6, 'first S-box word');
  assert.equal(w[18 + 1023], 0x3ac372e6, 'last S-box word');
});

test('Blowfish matches the published test vectors', () => {
  const vectors = [
    ['0000000000000000', '0000000000000000', '4ef997456198dd78'],
    ['ffffffffffffffff', 'ffffffffffffffff', '51866fd5b85ecb8a'],
    ['0123456789abcdef', '1111111111111111', '61f9c3802281b096'],
    ['fedcba9876543210', '0123456789abcdef', '0aceab0fc6a0a28d'],
  ];
  for (const [key, plain, cipher] of vectors) {
    const bf = new Blowfish(fromHex(key));
    assert.equal(hex(bf.encrypt(fromHex(plain))), cipher, `encrypt with ${key}`);
    assert.equal(hex(bf.decrypt(fromHex(cipher))), plain, `decrypt with ${key}`);
  }
  const bf = new Blowfish(Uint8Array.from({ length: 56 }, (_, i) => i));
  const data = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
  assert.deepEqual(bf.decrypt(bf.encrypt(data)), data, 'ECB round trip with a 56-byte key');
  assert.throws(() => bf.decrypt(new Uint8Array(7)), /multiple of 8/);
});

test('the Westwood public key is a 319-bit modulus', () => {
  const { n, e } = westwoodPublicKey();
  assert.equal(n.toString(2).length, 319);
  assert.equal(e, 65537n);
  assert.throws(() => parseKeyInteger(Uint8Array.from([3, 1, 5])), /INTEGER/);
  assert.equal(parseKeyInteger(Uint8Array.from([2, 0x81, 2, 1, 0])), 256n, 'long length form');
});

test('the key source decrypts to the Blowfish key (test RSA key)', () => {
  const key = testRsaKey(7);
  assert.equal(modPow(modPow(12345n, key.e, key.n), key.d, key.n), 12345n, 'test key is a valid RSA pair');
  const bfKey = Uint8Array.from({ length: 56 }, (_, i) => (i * 13 + 5) & 255);
  const source = encryptKeySource(bfKey, key);
  assert.equal(source.length, 80);
  assert.deepEqual(decryptKeySource(source, key), bfKey);
});

// ---- MIX -------------------------------------------------------------------------

test('file ids use the classic Westwood hash', () => {
  assert.equal(mixHash('local mix database.dat'), 0x54c2d545, 'the well-known XCC database id');
  assert.equal(mixHash('conscmp1.aud'), mixHash('CONSCMP1.AUD'), 'case-insensitive');
  assert.notEqual(mixHash('ackno.v00'), mixHash('ackno.v01'));
  assert.equal(mixHash('abcd'), 0x44434241, 'one chunk: its little-endian value');
  assert.equal(mixHash('abcde'), (((0x44434241 << 1) | (0x44434241 >>> 31)) + 0x45) >>> 0, 'zero padded');
});

const FILES = [
  { name: 'cannon1.aud', data: Uint8Array.from([1, 2, 3, 4]) },
  { name: 'conscmp1.aud', data: Uint8Array.from([9, 8, 7]) },
  { name: 'ackno.v01', data: Uint8Array.from([5]) },
];

for (const layout of ['td', 'ra']) {
  test(`reads a ${layout === 'td' ? 'Tiberian Dawn' : 'Red Alert'} MIX`, async () => {
    const mix = await MixArchive.open(bytesSource(buildMix(FILES, { layout })));
    assert.equal(mix.encrypted, false);
    assert.equal(mix.entries.size, 3);
    for (const f of FILES) assert.deepEqual(await mix.read(f.name), f.data, f.name);
    assert.equal(await mix.read('missing.aud'), null);
    assert.ok(mix.has('CANNON1.AUD'));
  });
}

test('reads a Red Alert MIX with a checksum and from a Blob', async () => {
  const bytes = buildMix(FILES, { checksum: true });
  const mix = await MixArchive.open(blobSource(new Blob([bytes])));
  assert.deepEqual(await mix.read('conscmp1.aud'), FILES[1].data);
});

test('reads a MIX with an encrypted index', async () => {
  const key = testRsaKey(3);
  const bytes = buildEncryptedMix(FILES, key);
  const mix = await MixArchive.open(bytesSource(bytes), { publicKey: key });
  assert.equal(mix.encrypted, true);
  for (const f of FILES) assert.deepEqual(await mix.read(f.name), f.data, f.name);
  // With the wrong key the index is garbage and is rejected, not trusted.
  await assert.rejects(MixArchive.open(bytesSource(bytes), { publicKey: testRsaKey(9) }), MixError);
});

test('archives nest: an entry can be opened as a MIX', async () => {
  const inner = buildMix([{ name: 'unitrdy1.aud', data: Uint8Array.from([42, 43]) }]);
  const outer = await MixArchive.open(bytesSource(buildMix([{ name: 'speech.mix', data: inner }, ...FILES])));
  const nested = await MixArchive.open(outer.entrySource('speech.mix'));
  assert.deepEqual(await nested.read('unitrdy1.aud'), Uint8Array.from([42, 43]));
});

test('files that are not MIX archives are rejected', async () => {
  await assert.rejects(MixArchive.open(bytesSource(new Uint8Array(3))), MixError);
  await assert.rejects(MixArchive.open(bytesSource(imaAud(sineSamples(100)))), MixError);
  const bad = buildMix(FILES);
  new DataView(bad.buffer).setUint32(4 + 6 + 4, 1e6, true); // first entry offset beyond the data
  await assert.rejects(MixArchive.open(bytesSource(bad)), /outside the data/);
});

// ---- AUD ------------------------------------------------------------------------------

test('IMA ADPCM decodes the low nibble first and carries its state', () => {
  const state = { index: 0, sample: 0 };
  assert.equal(imaDecodeNibble(7, state), 12, 'step 7: 7*7/4 + 7/8');
  assert.equal(state.index, 8);
  assert.equal(imaDecodeNibble(15, state), -18, 'step 16, negative: -(28 + 2)');
  assert.equal(state.index, 16);
  const aud = audFile({ chunks: [[Uint8Array.from([0xf7]), 4]] });
  assert.deepEqual(Array.from(decodeAud(aud).samples, (s) => Math.round(s * 32768)), [12, -18]);
  // The predictor clamps to 16 bits.
  const loud = { index: 88, sample: 32000 };
  assert.equal(imaDecodeNibble(7, loud), 32767);
});

test('an IMA .aud round-trips a tone across chunks', () => {
  const tone = sineSamples(3001, 440, 22050);
  const bytes = imaAud(tone, { chunkBytes: 100 });
  assert.ok(looksLikeAud(bytes));
  const { sampleRate, samples } = decodeAud(bytes);
  assert.equal(sampleRate, 22050);
  assert.equal(samples.length, 3002, 'two samples per byte');
  let err = 0;
  let sig = 0;
  for (let i = 0; i < tone.length; i++) {
    err += (samples[i] * 32768 - tone[i]) ** 2;
    sig += tone[i] ** 2;
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 20, `decoded tone is close to the original: ${snr.toFixed(1)} dB`);
  // Same bytes as one chunk: state carried across chunks gives the same result.
  const whole = decodeAud(audFile({ chunks: [[imaEncode(tone), 3002 * 2]] })).samples;
  assert.deepEqual(samples, whole);
});

test('Westwood ADPCM decodes every command type', () => {
  const chunk = Uint8Array.from([
    0xc2, // repeat the current sample (0x80) 3 times
    0x81, 100, 120, // 2 raw samples
    0xbd, // 5-bit delta -3
    0x40, 0x9f, // 4-bit: +8 then +1
    0x00, 0xe4, // 2-bit: -2, -1, 0, +1
  ]);
  const out = new Uint8Array(12);
  assert.equal(wsDecodeChunk(chunk, out, 12), 12);
  assert.deepEqual(Array.from(out), [128, 128, 128, 100, 120, 117, 125, 126, 124, 123, 123, 124]);
  // Deltas clamp to 0..255.
  const low = new Uint8Array(3);
  wsDecodeChunk(Uint8Array.from([0x80, 1, 0x40, 0x00]), low, 3);
  assert.deepEqual(Array.from(low), [1, 0, 0]);
  // A chunk whose sizes match is stored raw.
  const raw = Uint8Array.from([10, 20, 30]);
  const aud = decodeAud(wsAud([[raw, 3], [chunk, 12]]));
  assert.equal(aud.sampleRate, 11025);
  assert.deepEqual(
    Array.from(aud.samples, (s) => Math.round(s * 128 + 128)),
    [10, 20, 30, 128, 128, 128, 100, 120, 117, 125, 126, 124, 123, 123, 124],
  );
});

test('broken or unsupported .aud files are rejected', () => {
  assert.throws(() => decodeAud(new Uint8Array(5)), AudError);
  assert.throws(() => decodeAud(audFile({ format: 7, chunks: [[new Uint8Array(1), 4]] })), /unknown AUD format/);
  assert.throws(() => decodeAud(audFile({ flags: 3, chunks: [[new Uint8Array(1), 4]] })), /stereo/);
  const bad = imaAud(sineSamples(64));
  new DataView(bad.buffer).setUint32(12 + 4, 0x1234, true);
  assert.throws(() => decodeAud(bad), /bad AUD chunk/);
  assert.equal(looksLikeAud(bad), false);
  assert.throws(() => decodeAud(imaAud(sineSamples(64)).subarray(0, 30)), /truncated/);
});
