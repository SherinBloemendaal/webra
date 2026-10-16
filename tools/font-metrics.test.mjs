// The woff2 metrics reader (tools/font-metrics.mjs) on a synthetic font:
// a woff2 container built here around hand-made head, hhea and OS/2 tables,
// with a transformed glyf and loca and an untransformed table in between, so
// the reader has to walk the table directory and the stream offsets right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { readFontMetrics } from './font-metrics.mjs';

/** UIntBase128 of the woff2 table directory. */
function base128(n) {
  const bytes = [n & 0x7f];
  for (n >>>= 7; n > 0; n >>>= 7) bytes.unshift((n & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

function head(unitsPerEm) {
  const b = Buffer.alloc(54);
  b.writeUInt16BE(1, 0);
  b.writeUInt32BE(0x5f0f3cf5, 12);
  b.writeUInt16BE(unitsPerEm, 18);
  return b;
}

function hhea(asc, desc, gap) {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(1, 0);
  b.writeInt16BE(asc, 4);
  b.writeInt16BE(desc, 6);
  b.writeInt16BE(gap, 8);
  return b;
}

function os2({ version = 4, fsSelection = 0x80, typoAsc, typoDesc, typoGap, winAsc, winDesc, xHeight, capHeight }) {
  const b = Buffer.alloc(96);
  b.writeUInt16BE(version, 0);
  b.writeUInt16BE(fsSelection, 62);
  b.writeInt16BE(typoAsc, 68);
  b.writeInt16BE(typoDesc, 70);
  b.writeInt16BE(typoGap, 72);
  b.writeUInt16BE(winAsc, 74);
  b.writeUInt16BE(winDesc, 76);
  b.writeInt16BE(xHeight, 86);
  b.writeInt16BE(capHeight, 88);
  return b;
}

/**
 * A woff2 file of `tables`: [{ index, data, transformLength? }] in stream
 * order. glyf (10) and loca (11) are written transformed (version 0), so
 * their stream length is transformLength, not the table's own length.
 */
function woff2(tables) {
  const dir = [];
  for (const t of tables) {
    dir.push(Buffer.from([t.index & 0x3f]), base128(t.origLength ?? t.data.length));
    if (t.transformLength !== undefined) dir.push(base128(t.transformLength));
  }
  const stream = Buffer.concat(tables.map((t) => t.data));
  const compressed = brotliCompressSync(stream);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(compressed.length, 20);
  const out = Buffer.concat([header, ...dir, compressed]);
  out.writeUInt32BE(out.length, 8);
  return out;
}

const METRICS = { typoAsc: 1000, typoDesc: -200, typoGap: 0, winAsc: 1075, winDesc: 274, xHeight: 514, capHeight: 700 };

test('reads unitsPerEm, hhea and OS/2 metrics past transformed and plain tables', () => {
  const font = woff2([
    { index: 0, data: Buffer.alloc(12, 7) }, // cmap
    { index: 1, data: head(1000) },
    { index: 10, data: Buffer.alloc(30, 1), origLength: 400, transformLength: 30 }, // glyf
    { index: 11, data: Buffer.alloc(0), origLength: 20, transformLength: 0 }, // loca
    { index: 2, data: hhea(1000, -200, 0) },
    { index: 5, data: Buffer.alloc(9, 3) }, // name
    { index: 6, data: os2(METRICS) },
  ]);
  assert.deepEqual(readFontMetrics(font), {
    unitsPerEm: 1000,
    hheaAscender: 1000,
    hheaDescender: -200,
    hheaLineGap: 0,
    typoAscender: 1000,
    typoDescender: -200,
    typoLineGap: 0,
    winAscent: 1075,
    winDescent: 274,
    useTypoMetrics: true,
    xHeight: 514,
    capHeight: 700,
  });
});

test('reports USE_TYPO_METRICS off and other units per em', () => {
  const font = woff2([
    { index: 1, data: head(2048) },
    { index: 2, data: hhea(1900, -500, 67) },
    { index: 6, data: os2({ ...METRICS, fsSelection: 0x40, capHeight: 1434 }) },
  ]);
  const m = readFontMetrics(font);
  assert.equal(m.unitsPerEm, 2048);
  assert.equal(m.hheaLineGap, 67);
  assert.equal(m.useTypoMetrics, false);
  assert.equal(m.capHeight, 1434);
});

test('refuses files that are not woff2, lack a table or have no cap height', () => {
  assert.throws(() => readFontMetrics(Buffer.from('wOFF0000000000000000000000000000000000000000000000')), /not a woff2/);
  assert.throws(() => readFontMetrics(woff2([{ index: 1, data: head(1000) }, { index: 2, data: hhea(1, -1, 0) }])), /no OS\/2/);
  assert.throws(
    () => readFontMetrics(woff2([{ index: 1, data: head(1000) }, { index: 2, data: hhea(1, -1, 0) }, { index: 6, data: os2({ ...METRICS, version: 1 }) }])),
    /sCapHeight/,
  );
});
