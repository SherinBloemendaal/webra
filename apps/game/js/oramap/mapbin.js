// OpenRA map.bin reader (Map.LoadBinaryData).
//
// Layout, little endian:
//   u8  format (1 or 2)
//   u16 width, u16 height
//   format 2 only: u32 tilesOffset, u32 heightsOffset, u32 resourcesOffset
//     (0 = layer absent; current OpenRA writes 17, 0 or 17 + 3*w*h, ...)
//   tiles:     per cell u16 template id + u8 tile index
//   heights:   per cell u8 (only on maps with terrain height, not Red Alert)
//   resources: per cell u8 resource type + u8 density
// Format 1 has no offsets: tiles follow the header, resources follow the tiles.
// Cells are stored column by column (x outer, y inner). A tile index of 255
// means "pick any": OpenRA uses (x % 4) + (y % 4) * 4.

export class MapBinError extends Error {}

export const MAPBIN_LIMITS = Object.freeze({ maxSide: 1024 });

/**
 * @param {Uint8Array} bytes
 * @param {Partial<typeof MAPBIN_LIMITS>} [limits]
 * @returns {{ format: number, width: number, height: number,
 *   tileType: Uint16Array, tileIndex: Uint8Array,
 *   resType: Uint8Array, resDensity: Uint8Array }} layers in row-major order
 */
export function readMapBin(bytes, limits = {}) {
  const lim = { ...MAPBIN_LIMITS, ...limits };
  if (!(bytes instanceof Uint8Array)) throw new MapBinError('map.bin: not a byte array');
  if (bytes.length < 5) throw new MapBinError('map.bin: truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = bytes[0];
  const width = view.getUint16(1, true);
  const height = view.getUint16(3, true);
  if (format !== 1 && format !== 2) throw new MapBinError(`map.bin: unknown format ${format}`);
  if (width < 1 || height < 1 || width > lim.maxSide || height > lim.maxSide) {
    throw new MapBinError(`map.bin: invalid size ${width}x${height}`);
  }
  const cells = width * height;
  let tilesOffset;
  let resourcesOffset;
  if (format === 1) {
    tilesOffset = 5;
    resourcesOffset = 5 + 3 * cells;
  } else {
    if (bytes.length < 17) throw new MapBinError('map.bin: truncated header');
    tilesOffset = view.getUint32(5, true);
    const heightsOffset = view.getUint32(9, true);
    resourcesOffset = view.getUint32(13, true);
    if (heightsOffset !== 0 && (heightsOffset < 17 || heightsOffset + cells > bytes.length)) {
      throw new MapBinError('map.bin: height layer out of range');
    }
  }
  const section = (offset, per, what) => {
    if (offset === 0) return false;
    if (offset < (format === 1 ? 5 : 17) || offset + per * cells > bytes.length) {
      throw new MapBinError(`map.bin: ${what} layer out of range (truncated file?)`);
    }
    return true;
  };

  const tileType = new Uint16Array(cells);
  const tileIndex = new Uint8Array(cells);
  const resType = new Uint8Array(cells);
  const resDensity = new Uint8Array(cells);

  if (!section(tilesOffset, 3, 'tile')) throw new MapBinError('map.bin: no tile layer');
  let o = tilesOffset;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      tileType[i] = view.getUint16(o, true);
      const idx = bytes[o + 2];
      tileIndex[i] = idx === 255 ? (x % 4) + (y % 4) * 4 : idx;
      o += 3;
    }
  }
  // Resources are optional in format 2 (offset 0); format 1 always has them.
  if (section(resourcesOffset, 2, 'resource')) {
    o = resourcesOffset;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        resType[i] = bytes[o];
        resDensity[i] = bytes[o + 1];
        o += 2;
      }
    }
  }
  return { format, width, height, tileType, tileIndex, resType, resDensity };
}
