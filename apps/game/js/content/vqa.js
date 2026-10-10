// Westwood VQA movies (Red Alert's campaign briefings, movies1.mix and
// movies2.mix on the CDs), decoded in the browser from the player's own
// files. Plain JS without dependencies (browsers and Node).
//
// Layout (IFF style; chunk sizes are big-endian, other numbers little-endian):
//   "FORM" u32be size "WVQA"
//   "VQHD" u32be 42: u16 version, u16 flags (0x10: 15-bit colour, Tiberian
//     Sun), u16 frames, u16 width, u16 height, u8 block width, u8 block
//     height, u8 frame rate, u8 codebook parts, u16 colours, u16 max blocks,
//     u16, u32, u16 sample rate, u8 channels, u8 sample bits, u32, u16,
//     u32 max CBFZ size, u32
//   other header chunks (skipped), then "FINF": u32le per frame, the frame's
//     file offset in 16-bit words (bit 30 marks key frames)
//   per frame: "VQFR" (or "VQFL") with sub-chunks, and sound chunks:
//     CBF0 / CBFZ  the whole codebook (Z: LCW compressed)
//     CBP0 / CBPZ  one part of the next codebook; once all parts are in,
//                  the codebook changes at the start of the following frame
//     CPL0 / CPLZ  palette (6-bit RGB)
//     VPT0 / VPTZ  vector pointers: per block a low byte (first half) and a
//                  high byte (second half); high byte 0x0f (4x2 blocks) or
//                  0xff (4x4) means a block of one colour, the low byte
//     VPTR / VPRZ  15-bit videos: a stream of block instructions
//     SND0 raw PCM, SND1 Westwood ADPCM, SND2 IMA ADPCM (stereo: the left
//     half of a chunk, then the right half)
// Chunks start on even offsets: a zero byte before a tag is padding.
//
// Every file is hostile: sizes are capped, each offset and length is
// checked, decompression never writes past its buffer, and anything wrong
// throws VqaError. The algorithms follow OpenRA (OpenRA.Mods.Cnc VqaVideo,
// LCWCompression; OpenRA.Mods.Common ImaAdpcmReader,
// WestwoodCompressedReader; GPL-3.0).

import { imaDecodeNibble, wsDecodeChunk } from '../audio/aud.js';

export class VqaError extends Error {}

export const VQA_LIMITS = Object.freeze({
  /** Largest file (Red Alert's movies are a few megabytes to a few dozen). */
  maxBytes: 64 * 1024 * 1024,
  maxWidth: 1024,
  maxHeight: 768,
  maxFrameRate: 60,
  /** Longest sound track, in samples per channel (12 minutes at Red Alert's 22050 Hz). */
  maxAudioSamples: 16 * 1024 * 1024,
});

const HEADER_BYTES = 42;
const FLAG_HQ = 0x10;
/** 15-bit videos: codebook and instruction buffers (OpenRA's maxCbfzSize). */
const HQ_BUFFER = 256000;

const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const isTagByte = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a);

/**
 * Decode LCW (Format80) from `src[start, end)` into `dest`. `relative`
 * makes the long copies (commands 3 and 5) count back from the write
 * position instead of from the start (codebooks of 15-bit videos). Returns
 * the number of bytes written. Throws VqaError on data that reads past
 * `end`, writes past `dest`, or copies from outside what was written.
 */
export function lcwDecode(src, start, end, dest, relative = false) {
  let s = start;
  let d = 0;
  const need = (n) => {
    if (s + n > end) throw new VqaError('corrupt LCW data (reads past the end of its chunk)');
  };
  const room = (n) => {
    if (d + n > dest.length) throw new VqaError('corrupt LCW data (overruns its output)');
  };
  for (;;) {
    need(1);
    const i = src[s++];
    if ((i & 0x80) === 0) {
      // Command 2: copy `count` bytes from `back` bytes back.
      need(1);
      const count = ((i & 0x70) >> 4) + 3;
      const back = ((i & 0x0f) << 8) | src[s++];
      room(count);
      if (back === 0 || back > d) throw new VqaError('corrupt LCW data (bad back reference)');
      for (let k = 0; k < count; k++, d++) dest[d] = dest[d - back];
    } else if ((i & 0x40) === 0) {
      // Command 1: literal bytes; 0x80 ends the data.
      const count = i & 0x3f;
      if (count === 0) return d;
      need(count);
      room(count);
      dest.set(src.subarray(s, s + count), d);
      s += count;
      d += count;
    } else if ((i & 0x3f) === 0x3e) {
      // Command 4: a run of one byte.
      need(3);
      const count = u16(src, s);
      const value = src[s + 2];
      s += 3;
      room(count);
      dest.fill(value, d, d + count);
      d += count;
    } else {
      // Commands 3 (short) and 5 (long): copy from earlier output.
      let count = (i & 0x3f) + 3;
      if ((i & 0x3f) === 0x3f) {
        need(2);
        count = u16(src, s);
        s += 2;
      }
      need(2);
      const word = u16(src, s);
      s += 2;
      let from = relative ? d - word : word;
      if (from < 0 || from >= d) throw new VqaError('corrupt LCW data (copies from outside the output)');
      room(count);
      for (let k = 0; k < count; k++) dest[d++] = dest[from++];
    }
  }
}

/** Whether `bytes` starts like a VQA movie. */
export function looksLikeVqa(bytes) {
  return bytes.length >= 12 && tagAt(bytes, 0) === 'FORM' && tagAt(bytes, 8) === 'WVQA';
}

/**
 * The chunk at `p` in `bytes[p, end)`: { tag, at (data start), size, next },
 * or null when only zero padding is left. A zero byte where a tag should
 * start is alignment padding.
 */
function chunkAt(bytes, p, end, what) {
  if (bytes[p] === 0 && p + 1 < end && isTagByte(bytes[p + 1])) p++;
  if (p + 8 > end) {
    if (bytes.subarray(p, end).every((v) => v === 0)) return null;
    throw new VqaError(`not a VQA movie (truncated chunk in ${what})`);
  }
  const tag = tagAt(bytes, p);
  const size = u32be(bytes, p + 4);
  if (p + 8 + size > end) throw new VqaError(`not a VQA movie (${tag.replace(/[^\x20-\x7e]/g, '?')} chunk in ${what} runs past the end)`);
  return { tag, at: p + 8, size, next: p + 8 + size };
}

/** The chunks in `bytes[start, end)`. */
function chunksIn(bytes, start, end, what) {
  const out = [];
  for (let p = start; p < end; ) {
    const c = chunkAt(bytes, p, end, what);
    if (!c) break;
    out.push(c);
    p = c.next;
  }
  return out;
}

/**
 * Open a VQA movie: checks the header, the frame index and the chunk
 * structure of every frame (no pixels are decoded yet). Throws VqaError.
 * @param {Uint8Array} bytes
 * @returns {VqaVideo}
 */
export function openVqa(bytes, limits = VQA_LIMITS) {
  if (bytes.length > limits.maxBytes) throw new VqaError(`movie too large (${bytes.length} bytes, at most ${limits.maxBytes})`);
  if (!looksLikeVqa(bytes)) throw new VqaError('not a VQA movie (no FORM/WVQA header)');
  const vqhd = chunkAt(bytes, 12, bytes.length, 'the header');
  if (!vqhd || vqhd.tag !== 'VQHD' || vqhd.size < HEADER_BYTES) throw new VqaError('not a VQA movie (no VQHD header first)');
  const h = vqhd.at;
  const header = {
    version: u16(bytes, h),
    flags: u16(bytes, h + 2),
    frames: u16(bytes, h + 4),
    width: u16(bytes, h + 6),
    height: u16(bytes, h + 8),
    blockWidth: bytes[h + 10],
    blockHeight: bytes[h + 11],
    frameRate: bytes[h + 12],
    cbParts: bytes[h + 13],
    colors: u16(bytes, h + 14),
    sampleRate: u16(bytes, h + 24),
    channels: bytes[h + 26],
    sampleBits: bytes[h + 27],
  };
  if (header.version !== 2 && header.version !== 3) throw new VqaError(`VQA version ${header.version} is not supported (Red Alert movies are version 2)`);
  if (!header.frames) throw new VqaError('not a VQA movie (no frames)');
  if (!header.width || !header.height || header.width > limits.maxWidth || header.height > limits.maxHeight) {
    throw new VqaError(`movie size ${header.width}x${header.height} is not supported (at most ${limits.maxWidth}x${limits.maxHeight})`);
  }
  if (header.blockWidth !== 4 || (header.blockHeight !== 2 && header.blockHeight !== 4)) {
    throw new VqaError(`block size ${header.blockWidth}x${header.blockHeight} is not supported (4x2 or 4x4)`);
  }
  if (header.width % header.blockWidth || header.height % header.blockHeight) throw new VqaError('movie size is not a whole number of blocks');
  if (!header.frameRate || header.frameRate > limits.maxFrameRate) throw new VqaError(`frame rate ${header.frameRate} is not supported`);
  if (header.colors > 256) throw new VqaError('more than 256 palette colours');
  // Other header chunks (CINF, LINF and friends in later games) come before the frame index.
  let finf = vqhd;
  while (finf.tag !== 'FINF') {
    finf = chunkAt(bytes, finf.next, bytes.length, 'the header');
    if (!finf) throw new VqaError('not a VQA movie (no FINF frame index)');
  }
  if (finf.size < header.frames * 4) throw new VqaError('not a VQA movie (frame index too short)');
  const dataStart = finf.at + finf.size;
  const offsets = new Array(header.frames);
  for (let i = 0; i < header.frames; i++) {
    const at = (u32(bytes, finf.at + i * 4) & 0x3fffffff) * 2;
    if (at < dataStart || at >= bytes.length || (i && at < offsets[i - 1])) throw new VqaError(`not a VQA movie (frame ${i} lies outside the file)`);
    offsets[i] = at;
  }
  const frames = offsets.map((at, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : bytes.length;
    const chunks = chunksIn(bytes, at, end, `frame ${i}`);
    for (const c of chunks) {
      if (c.tag === 'VQFR' || c.tag === 'VQFL') c.sub = chunksIn(bytes, c.at, c.at + c.size, `frame ${i}`);
    }
    return chunks;
  });
  return new VqaVideo(bytes, header, frames, limits);
}

export class VqaVideo {
  constructor(bytes, header, frames, limits) {
    this.bytes = bytes;
    this.header = header;
    this.frames = frames;
    this.limits = limits;
    this.width = header.width;
    this.height = header.height;
    this.frameRate = header.frameRate;
    this.frameCount = header.frames;
    this.hq = (header.flags & FLAG_HQ) !== 0;
    this.hasAudio = frames.some((f) => f.some((c) => /^SND[012]$/.test(c.tag)));
    this.blocksX = header.width / header.blockWidth;
    this.blocksY = header.height / header.blockHeight;
    this.blockSize = header.blockWidth * header.blockHeight;
    /** The high byte of a vector pointer that means "one colour" (8-bit videos). */
    this.solid = header.blockHeight === 2 ? 0x0f : 0xff;
    const cbCap = this.hq ? HQ_BUFFER * 3 : Math.max(this.solid * 256 * this.blockSize, header.width * header.height);
    this.cbf = new Uint8Array(cbCap);
    this.cbp = new Uint8Array(this.hq ? HQ_BUFFER : cbCap);
    this.scratch = this.hq ? new Uint8Array(HQ_BUFFER) : null;
    this.vectors = new Uint8Array(this.hq ? HQ_BUFFER : 2 * this.blocksX * this.blocksY);
    this.palette = new Uint8Array(256 * 4);
    /** The current frame, RGBA (`width * height * 4`). */
    this.rgba = new Uint8ClampedArray(header.width * header.height * 4);
    this.reset();
  }

  /** Back to before the first frame. */
  reset() {
    this.frameIndex = 0;
    this.cbf.fill(0);
    this.cbpFill = 0;
    this.cbpParts = 0;
    this.cbpCompressed = false;
    this.vectorBytes = 0;
    this.palette.fill(0);
    for (let i = 3; i < this.palette.length; i += 4) this.palette[i] = 255;
    this.rgba.fill(0);
    for (let i = 3; i < this.rgba.length; i += 4) this.rgba[i] = 255;
  }

  /** Decode the next frame into `rgba` and return it, or null after the last frame. Throws VqaError. */
  nextFrame() {
    if (this.frameIndex >= this.frameCount) return null;
    const chunks = this.frames[this.frameIndex++];
    let vectors = false;
    for (const c of chunks) {
      if (c.tag === 'VQFR' || c.tag === 'VQFL') vectors = this.readFrame(c) || vectors;
    }
    if (vectors) this.draw();
    return this.rgba;
  }

  /** Decode up to frame `n` (from the start when it lies behind) and return it. */
  frame(n) {
    if (!Number.isInteger(n) || n < 0 || n >= this.frameCount) throw new VqaError(`no frame ${n}`);
    if (n < this.frameIndex - 1) this.reset();
    while (this.frameIndex <= n) this.nextFrame();
    return this.rgba;
  }

  /** Read one VQFR (or VQFL) chunk; returns whether it carried vector pointers. */
  readFrame(chunk) {
    const b = this.bytes;
    const parts = this.header.cbParts;
    // All parts of the next codebook arrived in earlier frames: it applies now.
    if (parts && this.cbpParts === parts) {
      if (this.cbpCompressed) {
        this.cbf.fill(0);
        lcwDecode(this.cbp, 0, this.cbpFill, this.cbf);
      } else {
        this.cbf.fill(0);
        this.cbf.set(this.cbp.subarray(0, this.cbpFill));
      }
      this.cbpFill = 0;
      this.cbpParts = 0;
    }
    for (const c of chunk.sub) {
      const end = c.at + c.size;
      switch (c.tag) {
        case 'CBF0':
          if (c.size > this.cbf.length) throw new VqaError('codebook larger than the movie allows');
          this.cbf.fill(0);
          this.cbf.set(b.subarray(c.at, end));
          break;
        case 'CBFZ':
          this.readCodebook(c);
          if (chunk.tag === 'VQFL') return false;
          break;
        case 'CBP0':
        case 'CBPZ':
          if (this.cbpFill + c.size > this.cbp.length) throw new VqaError('codebook parts larger than the movie allows');
          this.cbp.set(b.subarray(c.at, end), this.cbpFill);
          this.cbpFill += c.size;
          this.cbpParts++;
          this.cbpCompressed = c.tag === 'CBPZ';
          break;
        case 'CPL0':
          this.setPalette(b.subarray(c.at, end));
          break;
        case 'CPLZ': {
          const raw = new Uint8Array(256 * 3);
          const n = b[c.at] === 0 ? lcwDecode(b, c.at + 1, end, raw, true) : lcwDecode(b, c.at, end, raw);
          this.setPalette(raw.subarray(0, n));
          break;
        }
        case 'VPT0':
        case 'VPTR':
          if (c.size > this.vectors.length) throw new VqaError('vector pointers larger than the movie allows');
          this.vectors.fill(0);
          this.vectors.set(b.subarray(c.at, end));
          this.vectorBytes = c.size;
          return true;
        case 'VPTZ':
        case 'VPRZ':
          this.vectors.fill(0);
          this.vectorBytes = b[c.at] === 0 && c.tag === 'VPRZ' ? lcwDecode(b, c.at + 1, end, this.vectors, true) : lcwDecode(b, c.at, end, this.vectors);
          return true;
        default:
          throw new VqaError(`unknown frame chunk ${c.tag.replace(/[^\x20-\x7e]/g, '?')}`);
      }
    }
    return false;
  }

  /** A whole compressed codebook (CBFZ); a leading zero byte selects relative copies. */
  readCodebook(c) {
    const b = this.bytes;
    const end = c.at + c.size;
    const relative = c.size > 0 && b[c.at] === 0;
    const start = relative ? c.at + 1 : c.at;
    if (!this.hq) {
      this.cbf.fill(0);
      lcwDecode(b, start, end, this.cbf, relative);
      return;
    }
    // 15-bit colour (0rrrrrgg gggbbbbb), unpacked to RGB bytes.
    const packed = this.scratch;
    packed.fill(0);
    const n = lcwDecode(b, start, end, packed, relative);
    this.cbf.fill(0);
    let p = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      const v = (packed[i + 1] << 8) | packed[i];
      this.cbf[p++] = (v & 0x7c00) >> 7;
      this.cbf[p++] = (v & 0x3e0) >> 2;
      this.cbf[p++] = (v & 0x1f) << 3;
    }
  }

  setPalette(raw) {
    const n = Math.min(256, Math.floor(raw.length / 3));
    for (let i = 0; i < n; i++) {
      this.palette[i * 4] = (raw[i * 3] & 63) << 2;
      this.palette[i * 4 + 1] = (raw[i * 3 + 1] & 63) << 2;
      this.palette[i * 4 + 2] = (raw[i * 3 + 2] & 63) << 2;
      this.palette[i * 4 + 3] = 255;
    }
  }

  draw() {
    if (this.hq) this.drawHq();
    else this.draw8();
  }

  /** 8-bit videos: each block is a codebook entry of palette indexes, or one colour. */
  draw8() {
    const { blocksX, blocksY, blockSize, solid, cbf, palette, rgba, vectors } = this;
    const bw = this.header.blockWidth;
    const bh = this.header.blockHeight;
    const w = this.width;
    for (let y = 0; y < blocksY; y++) {
      for (let x = 0; x < blocksX; x++) {
        const lo = vectors[x + y * blocksX];
        const hi = vectors[x + (y + blocksY) * blocksX];
        const base = (hi * 256 + lo) * blockSize;
        if (hi !== solid && base + blockSize > cbf.length) throw new VqaError('vector pointer outside the codebook');
        for (let j = 0; j < bh; j++) {
          let o = ((y * bh + j) * w + x * bw) * 4;
          for (let i = 0; i < bw; i++, o += 4) {
            const c = (hi === solid ? lo : cbf[base + j * bw + i]) * 4;
            rgba[o] = palette[c];
            rgba[o + 1] = palette[c + 1];
            rgba[o + 2] = palette[c + 2];
            rgba[o + 3] = 255;
          }
        }
      }
    }
  }

  /** 15-bit videos: an instruction stream of skips, block runs and block lists. */
  drawHq() {
    const v = this.vectors;
    const size = this.vectorBytes;
    const { blocksX, blocksY } = this;
    let p = 0;
    const next = () => {
      if (p + 2 > size) throw new VqaError('vector instructions end too early');
      const value = v[p] | (v[p + 1] << 8);
      p += 2;
      return value;
    };
    const byte = () => {
      if (p + 1 > size) throw new VqaError('vector instructions end too early');
      return v[p++];
    };
    const at = { x: 0, y: 0 };
    const write = (block, count) => {
      for (let i = 0; i < count; i++) {
        if (at.y >= blocksY) throw new VqaError('vector instructions run past the frame');
        this.writeHqBlock(block, at.x, at.y);
        if (++at.x >= blocksX) {
          at.x = 0;
          at.y++;
        }
      }
    };
    while (at.y < blocksY) {
      while (at.x < blocksX && at.y < blocksY) {
        const val = next();
        const a = val & 0x1fff;
        const b1 = val & 0xff;
        const b2 = (((val >> 8) & 0x1f) + 1) * 2;
        switch (val >> 13) {
          case 0:
            at.x += a;
            break;
          case 1:
            write(b1, b2);
            break;
          case 2:
            write(b1, 1);
            for (let i = 0; i < b2; i++) write(byte(), 1);
            break;
          case 3:
            write(a, 1);
            break;
          case 5:
            write(a, byte());
            break;
          default:
            throw new VqaError(`unknown vector instruction ${val >> 13}`);
        }
      }
      if (at.x >= blocksX) {
        at.x = 0;
        at.y++;
      }
    }
  }

  writeHqBlock(block, bx, by) {
    const bw = this.header.blockWidth;
    const bh = this.header.blockHeight;
    const offset = block * this.blockSize * 3;
    if (offset + this.blockSize * 3 > this.cbf.length) throw new VqaError('vector pointer outside the codebook');
    for (let j = 0; j < bh; j++) {
      let o = ((by * bh + j) * this.width + bx * bw) * 4;
      for (let i = 0; i < bw; i++, o += 4) {
        const c = offset + (j * bw + i) * 3;
        this.rgba[o] = this.cbf[c];
        this.rgba[o + 1] = this.cbf[c + 1];
        this.rgba[o + 2] = this.cbf[c + 2];
        this.rgba[o + 3] = 255;
      }
    }
  }

  /**
   * The whole sound track: { sampleRate, channels, data: Float32Array per
   * channel } in -1..1, or null when the movie has none. Throws VqaError.
   */
  decodeAudio() {
    if (!this.hasAudio) return null;
    const hd = this.header;
    const channels = hd.channels || 1;
    if (channels > 2) throw new VqaError(`${channels} sound channels are not supported`);
    const sampleRate = hd.sampleRate || 22050;
    if (sampleRate < 8000 || sampleRate > 48000) throw new VqaError(`sample rate ${sampleRate} is not supported`);
    const bits = hd.sampleBits || 16;
    if (bits !== 8 && bits !== 16) throw new VqaError(`${bits}-bit sound is not supported`);
    const b = this.bytes;
    const chunks = this.frames.flatMap((f) => f.filter((c) => /^SND[012]$/.test(c.tag)));
    // Samples per channel of each chunk, so the output is allocated once.
    const samplesOf = (c) => {
      if (c.tag === 'SND2') return Math.floor(c.size / channels) * 2;
      if (c.tag === 'SND1') {
        if (channels !== 1) throw new VqaError('stereo Westwood ADPCM sound is not supported');
        if (c.size < 4) throw new VqaError('truncated SND1 chunk');
        return u16(b, c.at);
      }
      return Math.floor(c.size / channels / (bits / 8));
    };
    let total = 0;
    for (const c of chunks) total += samplesOf(c);
    if (total > this.limits.maxAudioSamples) throw new VqaError('sound track too long');
    const data = Array.from({ length: channels }, () => new Float32Array(total));
    const ima = Array.from({ length: channels }, () => ({ index: 0, sample: 0 }));
    const ws = new Uint8Array(65535);
    let w = 0;
    for (const c of chunks) {
      const n = samplesOf(c);
      if (c.tag === 'SND2') {
        const half = Math.floor(c.size / channels);
        for (let ch = 0; ch < channels; ch++) {
          const out = data[ch];
          const state = ima[ch];
          const from = c.at + half * ch;
          for (let k = 0; k < n / 2; k++) {
            const v = b[from + k];
            out[w + 2 * k] = imaDecodeNibble(v & 15, state) / 32768;
            out[w + 2 * k + 1] = imaDecodeNibble(v >> 4, state) / 32768;
          }
        }
      } else if (c.tag === 'SND1') {
        const inSize = u16(b, c.at + 2);
        if (4 + inSize > c.size) throw new VqaError('truncated SND1 chunk');
        const got = wsDecodeChunk(b.subarray(c.at + 4, c.at + 4 + inSize), ws, n);
        for (let k = 0; k < n; k++) data[0][w + k] = k < got ? (ws[k] - 128) / 128 : 0;
      } else {
        const half = Math.floor(c.size / channels);
        for (let ch = 0; ch < channels; ch++) {
          const out = data[ch];
          const from = c.at + half * ch;
          for (let k = 0; k < n; k++) {
            if (bits === 8) out[w + k] = (b[from + k] - 128) / 128;
            else out[w + k] = ((u16(b, from + 2 * k) << 16) >> 16) / 32768;
          }
        }
      }
      w += n;
    }
    return { sampleRate, channels, data };
  }
}
