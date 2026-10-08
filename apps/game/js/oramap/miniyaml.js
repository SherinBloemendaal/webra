// OpenRA MiniYaml parser (map.yaml and rules files inside .oramap packages).
//
// MiniYaml is a tree of `Key: Value` lines; children are indented one level
// deeper, a level being one tab or four spaces (not mixed on one line). `#`
// starts a comment unless escaped as `\#`. A line without a colon is a key
// with an empty value. Input is hostile: sizes, line count, node count and
// depth are limited, and errors carry the line number.

export class MiniYamlError extends Error {}

export const YAML_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxLines: 200_000,
  maxNodes: 100_000,
  maxDepth: 32,
  maxLineLength: 16 * 1024,
});

/**
 * @typedef {{ key: string, value: string, nodes: YamlNode[], line: number }} YamlNode
 */

function stripComment(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '#') {
      out += '#';
      i++;
    } else if (c === '#') {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Parse MiniYaml text into a list of top-level nodes.
 *
 * @param {string} text
 * @param {string} [file] name for error messages
 * @param {Partial<typeof YAML_LIMITS>} [limits]
 * @returns {YamlNode[]}
 */
export function parseMiniYaml(text, file = 'yaml', limits = {}) {
  const lim = { ...YAML_LIMITS, ...limits };
  if (typeof text !== 'string') throw new MiniYamlError(`${file}: not text`);
  if (text.length > lim.maxBytes) throw new MiniYamlError(`${file}: larger than ${lim.maxBytes} bytes`);
  const root = [];
  // stack[d] = the children list for depth d.
  const stack = [root];
  let nodes = 0;
  let lineNo = 0;
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let raw = text.slice(pos, end);
    pos = end + 1;
    lineNo++;
    if (lineNo > lim.maxLines) throw new MiniYamlError(`${file}: more than ${lim.maxLines} lines`);
    if (raw.length > lim.maxLineLength) throw new MiniYamlError(`${file}:${lineNo}: line too long`);
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);

    let tabs = 0;
    let spaces = 0;
    let start = 0;
    for (; start < raw.length; start++) {
      const c = raw[start];
      if (c === '\t') tabs++;
      else if (c === ' ') spaces++;
      else break;
    }
    const body = stripComment(raw.slice(start)).trim();
    if (body === '') {
      if (end === text.length) break;
      continue;
    }
    if (tabs > 0 && spaces > 0) throw new MiniYamlError(`${file}:${lineNo}: mixed tabs and spaces in the indentation`);
    if (spaces % 4 !== 0) throw new MiniYamlError(`${file}:${lineNo}: indentation is not a multiple of four spaces`);
    const depth = tabs + spaces / 4;
    if (depth > lim.maxDepth) throw new MiniYamlError(`${file}:${lineNo}: nested too deeply`);
    if (depth > stack.length - 1) throw new MiniYamlError(`${file}:${lineNo}: indented too far`);

    const colon = body.indexOf(':');
    const key = (colon < 0 ? body : body.slice(0, colon)).trim();
    const value = colon < 0 ? '' : body.slice(colon + 1).trim();
    if (key === '') throw new MiniYamlError(`${file}:${lineNo}: empty key`);
    if (++nodes > lim.maxNodes) throw new MiniYamlError(`${file}: more than ${lim.maxNodes} entries`);

    const node = { key, value, nodes: [], line: lineNo };
    stack.length = depth + 1;
    stack[depth].push(node);
    stack.push(node.nodes);
    if (end === text.length) break;
  }
  return root;
}

/** First child node with this key, or undefined. */
export function child(nodes, key) {
  return nodes?.find((n) => n.key === key);
}

/** Value of the first child with this key, or `fallback`. */
export function childValue(nodes, key, fallback = undefined) {
  const n = child(nodes, key);
  return n === undefined ? fallback : n.value;
}

/** Parse "a,b" into two integers (OpenRA int2 / CPos), or null. */
export function parseIntPair(value) {
  const m = /^\s*(-?\d{1,9})\s*,\s*(-?\d{1,9})\s*$/.exec(String(value ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Parse "a,b,c,d" into four integers (OpenRA Rectangle), or null. */
export function parseIntQuad(value) {
  const m = /^\s*(-?\d{1,9})\s*,\s*(-?\d{1,9})\s*,\s*(-?\d{1,9})\s*,\s*(-?\d{1,9})\s*$/.exec(String(value ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

/** Parse an integer (optionally signed), or null. */
export function parseInteger(value) {
  const m = /^\s*(-?\d{1,9})\s*$/.exec(String(value ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Parse an OpenRA WDist ("5c512" = 5 cells and 512 units, "1024", "-0c512").
 * Returns world units (1 cell = 1024) or null.
 */
export function parseWDist(value) {
  const s = String(value ?? '').trim();
  let m = /^(-?)(\d{1,6})c(\d{1,4})$/.exec(s);
  if (m) {
    const v = Number(m[2]) * 1024 + Number(m[3]);
    return m[1] ? -v : v;
  }
  m = /^-?\d{1,9}$/.exec(s);
  return m ? Number(s) : null;
}

/** Split a comma separated list, trimmed, empty items dropped. */
export function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
