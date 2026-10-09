// Westwood .aud sound files, decoded in the browser from the player's own
// game files (OpenRA's AudReader, WestwoodCompressedReader and ImaAdpcmReader
// describe the same formats).
//
// Header (12 bytes, little endian):
//   u16 sample rate, u32 compressed size, u32 output size,
//   u8 flags (1 stereo, 2 16-bit), u8 format (1 Westwood ADPCM, 99 IMA ADPCM)
// then chunks: u16 compressed size, u16 output size, u32 0x0000DEAF, data.
// IMA ADPCM keeps its predictor and step index across chunks; every byte holds
// two 4-bit codes, low nibble first, and decodes to two 16-bit samples.
// Westwood ADPCM decodes 8-bit unsigned samples with 2-bit and 4-bit deltas,
// raw runs and repeats; a chunk whose two sizes match is stored raw.

export const FORMAT_WESTWOOD = 1;
export const FORMAT_IMA = 99;
export const CHUNK_MAGIC = 0x0000deaf;
const HEADER = 12;
const CHUNK_HEADER = 8;

export class AudError extends Error {}

export const IMA_STEPS = Int16Array.from([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157,
  173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
  1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
  13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);
export const IMA_INDEX_ADJUST = Int8Array.from([-1, -1, -1, -1, 2, 4, 6, 8]);
const WS_STEP2 = Int8Array.from([-2, -1, 0, 1]);
const WS_STEP4 = Int8Array.from([-9, -8, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8]);

/** Decode one 4-bit IMA code; `state` is { index, sample } and is updated. */
export function imaDecodeNibble(code, state) {
  const step = IMA_STEPS[state.index];
  const mag = code & 7;
  let delta = ((step * mag) >> 2) + (step >> 3);
  if (code & 8) delta = -delta;
  state.sample = Math.max(-32768, Math.min(32767, state.sample + delta));
  state.index = Math.max(0, Math.min(88, state.index + IMA_INDEX_ADJUST[mag]));
  return state.sample;
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Decode one Westwood ADPCM chunk into `out` (8-bit unsigned samples).
 * Returns the number of samples written.
 */
export function wsDecodeChunk(input, out, outSize) {
  if (input.length === outSize) {
    out.set(input.subarray(0, outSize));
    return outSize;
  }
  let sample = 0x80;
  let r = 0;
  let w = 0;
  const put = (v) => {
    if (w < outSize) out[w++] = v;
  };
  while (r < input.length && w < outSize) {
    const cmd = input[r++];
    let count = cmd & 0x3f;
    switch (cmd >> 6) {
      case 0: // 2-bit deltas, four per byte
        for (count++; count > 0 && r < input.length; count--) {
          const code = input[r++];
          for (let s = 0; s < 8; s += 2) {
            sample = clampByte(sample + WS_STEP2[(code >> s) & 3]);
            put(sample);
          }
        }
        break;
      case 1: // 4-bit deltas, two per byte
        for (count++; count > 0 && r < input.length; count--) {
          const code = input[r++];
          sample = clampByte(sample + WS_STEP4[code & 15]);
          put(sample);
          sample = clampByte(sample + WS_STEP4[code >> 4]);
          put(sample);
        }
        break;
      case 2:
        if (count & 0x20) {
          // One 5-bit signed delta in the command byte itself.
          sample = clampByte(sample + ((count << 27) >> 27));
          put(sample);
        } else {
          // Raw samples.
          for (count++; count > 0 && r < input.length; count--) {
            sample = input[r++];
            put(sample);
          }
        }
        break;
      default: // repeat the last sample
        for (count++; count > 0; count--) put(sample);
    }
  }
  return w;
}

export function parseAudHeader(bytes) {
  if (bytes.length < HEADER) throw new AudError('not an AUD file (too small)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    sampleRate: dv.getUint16(0, true),
    dataSize: dv.getUint32(2, true),
    outputSize: dv.getUint32(6, true),
    flags: bytes[10],
    format: bytes[11],
  };
  if (header.format !== FORMAT_IMA && header.format !== FORMAT_WESTWOOD) throw new AudError(`unknown AUD format ${header.format}`);
  if (header.sampleRate < 2000 || header.sampleRate > 96000) throw new AudError(`implausible AUD sample rate ${header.sampleRate}`);
  if (header.flags & 1) throw new AudError('stereo AUD files are not supported (Red Alert uses mono)');
  if (HEADER + header.dataSize > bytes.length) throw new AudError('AUD file is truncated');
  return header;
}

/** Length in seconds of an AUD file, from its header (no decoding). */
export function audDuration(bytes) {
  const h = parseAudHeader(bytes);
  // Output size is in bytes: two per sample for IMA (16-bit), one for Westwood (8-bit).
  const samples = h.format === FORMAT_IMA ? h.outputSize >> 1 : h.outputSize;
  return samples / h.sampleRate;
}

/**
 * Decode an .aud file to mono float samples in [-1, 1].
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeAud(bytes) {
  const h = parseAudHeader(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ima = h.format === FORMAT_IMA;
  // Output size is in bytes: two per sample for IMA (16-bit), one for Westwood (8-bit).
  const total = ima ? h.outputSize >> 1 : h.outputSize;
  const samples = new Float32Array(total);
  const state = { index: 0, sample: 0 };
  const ws = ima ? null : new Uint8Array(65536);
  let n = 0;
  let pos = HEADER;
  const end = HEADER + h.dataSize;
  while (pos + CHUNK_HEADER <= end && n < total) {
    const csize = dv.getUint16(pos, true);
    const osize = dv.getUint16(pos + 2, true);
    if (dv.getUint32(pos + 4, true) !== CHUNK_MAGIC) throw new AudError('bad AUD chunk');
    pos += CHUNK_HEADER;
    if (pos + csize > end) throw new AudError('AUD chunk runs past the end');
    const chunk = bytes.subarray(pos, pos + csize);
    pos += csize;
    if (ima) {
      for (let i = 0; i < chunk.length && n < total; i++) {
        samples[n++] = imaDecodeNibble(chunk[i] & 15, state) / 32768;
        if (n < total) samples[n++] = imaDecodeNibble(chunk[i] >> 4, state) / 32768;
      }
    } else {
      const got = wsDecodeChunk(chunk, ws, osize);
      for (let i = 0; i < got && n < total; i++) samples[n++] = (ws[i] - 128) / 128;
    }
  }
  return { sampleRate: h.sampleRate, samples: n === total ? samples : samples.subarray(0, n) };
}

/** Whether `bytes` start with a plausible AUD header. */
export function looksLikeAud(bytes) {
  try {
    parseAudHeader(bytes);
    return bytes.length >= HEADER + CHUNK_HEADER && new DataView(bytes.buffer, bytes.byteOffset + HEADER + 4, 4).getUint32(0, true) === CHUNK_MAGIC;
  } catch {
    return false;
  }
}
