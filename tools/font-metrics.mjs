// Vertical metrics of a woff2 font file, read from its head, hhea and OS/2
// tables (none of which woff2 transforms, so no glyph decoding is needed).
// Used by the tests that check the design system's text-centring tokens
// (apps/game/css/theme.css, --ui-cap-*) against the self-hosted fonts.
//
//   node tools/font-metrics.mjs apps/game/fonts/barlow-condensed-latin-700.woff2
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// The woff2 known-table index (WOFF2 spec, 5.2): only the indices whose
// transform rules differ, and the three tables read here.
const TAG_HMTX = 3;
const TAG_GLYF = 10;
const TAG_LOCA = 11;
const WANTED = new Map([
  [1, 'head'],
  [2, 'hhea'],
  [6, 'OS/2'],
]);

function readBase128(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos.at++];
    if (i === 0 && byte === 0x80) throw new Error('woff2: UIntBase128 with a leading zero');
    if (value & 0xfe000000) throw new Error('woff2: UIntBase128 overflow');
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  throw new Error('woff2: UIntBase128 longer than 5 bytes');
}

/** The raw head, hhea and OS/2 tables of a woff2 file, as Buffers by tag. */
function woff2Tables(data) {
  if (data.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not a woff2 file');
  const flavor = data.readUInt32BE(4);
  if (flavor === 0x74746366) throw new Error('woff2: font collections are not supported');
  const numTables = data.readUInt16BE(12);
  const compressedSize = data.readUInt32BE(20);
  const pos = { at: 48 };
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const flags = data[pos.at++];
    const index = flags & 0x3f;
    let tag = null;
    if (index === 0x3f) {
      tag = data.subarray(pos.at, pos.at + 4).toString('latin1');
      pos.at += 4;
    }
    const version = flags >> 6;
    const origLength = readBase128(data, pos);
    // glyf and loca are transformed at version 0; every other table at a version other than 0.
    const transformed = index === TAG_GLYF || index === TAG_LOCA ? version === 0 : version !== 0;
    const length = transformed ? readBase128(data, pos) : origLength;
    if (transformed && index !== TAG_GLYF && index !== TAG_LOCA && index !== TAG_HMTX) {
      throw new Error(`woff2: unknown transform on table ${index}`);
    }
    entries.push({ name: index === 0x3f ? tag : WANTED.get(index), length });
  }
  const stream = brotliDecompressSync(data.subarray(pos.at, pos.at + compressedSize));
  const tables = {};
  let offset = 0;
  for (const e of entries) {
    if (e.name && ['head', 'hhea', 'OS/2'].includes(e.name)) tables[e.name] = stream.subarray(offset, offset + e.length);
    offset += e.length;
  }
  for (const name of ['head', 'hhea', 'OS/2']) if (!tables[name]) throw new Error(`woff2: no ${name} table`);
  return tables;
}

/**
 * The vertical metrics of a woff2 font, in font units: unitsPerEm; the
 * hhea ascender, descender and lineGap (what browsers on macOS use for the
 * line box); the OS/2 typo and win metrics, the USE_TYPO_METRICS flag, and
 * the cap and x heights. Descenders are negative, as in the font.
 */
export function readFontMetrics(data) {
  const t = woff2Tables(data);
  const os2 = t['OS/2'];
  const os2Version = os2.readUInt16BE(0);
  if (os2Version < 2) throw new Error('OS/2 table before version 2 has no sCapHeight');
  return {
    unitsPerEm: t.head.readUInt16BE(18),
    hheaAscender: t.hhea.readInt16BE(4),
    hheaDescender: t.hhea.readInt16BE(6),
    hheaLineGap: t.hhea.readInt16BE(8),
    typoAscender: os2.readInt16BE(68),
    typoDescender: os2.readInt16BE(70),
    typoLineGap: os2.readInt16BE(72),
    winAscent: os2.readUInt16BE(74),
    winDescent: os2.readUInt16BE(76),
    useTypoMetrics: (os2.readUInt16BE(62) & 0x80) !== 0,
    xHeight: os2.readInt16BE(86),
    capHeight: os2.readInt16BE(88),
  };
}

/** readFontMetrics of a file on disk. */
export function readFontMetricsFile(path) {
  return readFontMetrics(readFileSync(path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) console.log(file, readFontMetricsFile(file));
}
