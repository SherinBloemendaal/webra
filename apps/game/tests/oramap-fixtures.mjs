// Synthetic .oramap packages for the importer tests: a ZIP writer, a map.bin
// writer (OpenRA Map.SaveBinaryData layout) and map.yaml text. No real maps
// are committed; every fixture is generated here.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../js/oramap/zip.js';

/**
 * Build a ZIP archive.
 * @param {{ name: string, data: Uint8Array | string, method?: 0 | 8 }[]} entries
 */
export function buildZip(entries, { comment = '' } = {}) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const packed = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = enc.encode(e.name);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, (e.flags ?? 0) | 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const com = enc.encode(comment);
  const eocd = new Uint8Array(22 + com.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, com.length, true);
  eocd.set(com, 22);
  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Build map.bin. `tile(x, y)` returns [templateId, index]; `res(x, y)` returns [type, density].
 */
export function buildMapBin(w, h, tile, res = () => [0, 0], format = 2) {
  const cells = w * h;
  const header = format === 2 ? 17 : 5;
  const out = new Uint8Array(header + 3 * cells + 2 * cells);
  const v = new DataView(out.buffer);
  out[0] = format;
  v.setUint16(1, w, true);
  v.setUint16(3, h, true);
  if (format === 2) {
    v.setUint32(5, 17, true);
    v.setUint32(9, 0, true);
    v.setUint32(13, 17 + 3 * cells, true);
  }
  let o = header;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const [t, i] = tile(x, y);
      v.setUint16(o, t, true);
      out[o + 2] = i;
      o += 3;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const [t, d] = res(x, y);
      out[o] = t;
      out[o + 1] = d;
      o += 2;
    }
  }
  return out;
}

/** map.yaml text. `actors`: [{ type, owner, x, y, facing? }]. */
export function mapYaml({
  title = 'Test Valley',
  author = 'Tester',
  tileset = 'TEMPERAT',
  size = [48, 48],
  bounds = [2, 2, 44, 44],
  actors = [],
  extra = '',
  format = 12,
  multi = [['\t\tFaction: Random']],
}) {
  const lines = [
    `MapFormat: ${format}`,
    '',
    'RequiresMod: ra',
    '',
    `Title: ${title}`,
    '',
    `Author: ${author}`,
    '',
    `Tileset: ${tileset}`,
    '',
    `MapSize: ${size[0]},${size[1]}`,
    '',
    `Bounds: ${bounds.join(',')}`,
    '',
    'Visibility: Lobby',
    '',
    'Players:',
    '\tPlayerReference@Neutral:',
    '\t\tName: Neutral',
    '\t\tOwnsWorld: True',
    '\t\tNonCombatant: True',
    '\t\tFaction: allies',
    // The playable lobby slots Multi0, Multi1, ... with their extra lines.
    ...multi.flatMap((extraLines, k) => [`\tPlayerReference@Multi${k}:`, `\t\tName: Multi${k}`, '\t\tPlayable: True', ...extraLines]),
    '\tPlayerReference@Creeps:',
    '\t\tName: Creeps',
    '\t\tFaction: allies',
    '',
    'Actors:',
  ];
  actors.forEach((a, i) => {
    lines.push(`\tActor${i}: ${a.type}`, `\t\tOwner: ${a.owner ?? 'Neutral'}`, `\t\tLocation: ${a.x},${a.y}`);
    if (a.facing !== undefined) lines.push(`\t\tFacing: ${a.facing}`);
    if (a.health !== undefined) lines.push(`\t\tHealth: ${a.health}`);
    if (a.stance !== undefined) lines.push(`\t\tStance: ${a.stance}`);
  });
  if (extra) lines.push('', extra);
  return `${lines.join('\n')}\n`;
}

/** Template ids of the TEMPERAT tileset the fixtures use. */
export const T = { CLEAR: 255, WATER: 1, ROCK: 57 };

/**
 * A playable 48x48 test map: clear ground, a water pool, a rock strip, two
 * spawns, ore and gems fields, trees, a pillbox and a civilian building.
 */
export function sampleOramap({ extraYaml = '', extraFiles = [], actors, rulesRef, multi } = {}) {
  const w = 48;
  const h = 48;
  const tile = (x, y) => {
    if (x >= 20 && x < 26 && y >= 20 && y < 26) return [T.WATER, 0];
    if (x === 30 && y >= 4 && y < 14) return [T.ROCK, 0];
    return [T.CLEAR, 255];
  };
  const res = (x, y) => {
    if (x >= 10 && x < 13 && y >= 30 && y < 33) return [1, 0];
    if (x >= 36 && x < 38 && y >= 30 && y < 32) return [2, 0];
    return [0, 0];
  };
  const list = actors ?? [
    { type: 'mpspawn', x: 8, y: 8 },
    { type: 'mpspawn', x: 38, y: 38 },
    { type: 't01', x: 15, y: 15 },
    { type: 'v01', x: 15, y: 40 },
    { type: 'pbox', x: 25, y: 10 },
    { type: 'e1', owner: 'Multi0', x: 10, y: 12, facing: 256 },
    { type: 'waypoint', x: 3, y: 3 },
    { type: 'brl3', x: 0, y: 0 },
    { type: 'c1', x: 30, y: 30 },
  ];
  let extra = extraYaml;
  if (rulesRef) extra = `Rules: ${rulesRef}\n${extra}`;
  const yaml = mapYaml({ actors: list, extra, ...(multi ? { multi } : {}) });
  return buildZip([
    { name: 'map.yaml', data: yaml },
    { name: 'map.bin', data: buildMapBin(w, h, tile, res) },
    { name: 'map.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: 0 },
    ...extraFiles,
  ]);
}
