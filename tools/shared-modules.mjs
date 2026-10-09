// The game modules and stylesheets the website loads. While the play gate
// is on, the Worker serves /play only to accounts that may play
// (docs/security.md), but the account page has to work for signed-out visitors and it uses the
// game's account client, the protocol checks and the shared controls
// (js/ui/controls.js, css/controls.css). tools/build-dist.mjs copies exactly
// what the website loads from /lib/ (and what that imports, relatively)
// from apps/game into dist/lib/, keeping the layout, so the same source
// serves both and nothing else of the game becomes public.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const LIB_PREFIX = '/lib/';

/**
 * Module specifiers of static imports, re-exports (statements at the start
 * of a line) and literal dynamic imports in `source`. Comment lines (JSDoc
 * types such as `import('./x.js').T` included) are skipped.
 */
export function importsOf(source) {
  const out = new Set();
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  const patterns = [/^\s*import\s+(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/gm, /^\s*export\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const re of patterns) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** CSS references: `@import "x"`, `@import url(x)` and `url(x)` (data: URLs skipped). */
export function cssRefsOf(source) {
  const out = new Set();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g)) out.add(m[1]);
  for (const m of code.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) out.add(m[1]);
  return [...out].filter((r) => !r.startsWith('data:'));
}

/**
 * Resources an HTML page loads by itself (not links people follow): `src`,
 * `href`, `srcset`, `poster` and `data` of every element except `<a>` and
 * `<area>`.
 */
export function htmlRefsOf(source) {
  const out = new Set();
  const code = source.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of code.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
    const name = tag[1].toLowerCase();
    if (name === 'a' || name === 'area') continue;
    for (const attr of tag[2].matchAll(/\s(src|href|srcset|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const value = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim();
      if (attr[1].toLowerCase() === 'srcset') for (const part of value.split(',')) out.add(part.trim().split(/\s+/)[0]);
      else out.add(value);
    }
  }
  return [...out].filter(Boolean);
}

/**
 * Whether a reference from a website page points into the gated game: its
 * path, resolved and normalized the way a browser does (dot segments,
 * percent-encoded letters and slashes, case), is /play or under it.
 */
export function refersToGame(ref) {
  let path;
  try {
    const u = new URL(ref, 'https://webra.invalid/assets/page');
    if (u.origin !== 'https://webra.invalid') return false;
    path = u.pathname;
  } catch {
    return false;
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed escapes: judge the raw path.
  }
  const norm = new URL(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/'), 'https://webra.invalid').pathname.toLowerCase();
  return norm === '/play' || norm.startsWith('/play/') || /^\/play[.;]/.test(norm);
}

function websiteFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...websiteFiles(p));
    else if (/\.(js|html|css)$/.test(name)) files.push(p);
  }
  return files;
}

/** The references a website file loads by itself, by file type. */
function refsOfWebsiteFile(file) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.js')) return importsOf(text);
  if (file.endsWith('.css')) return cssRefsOf(text);
  return htmlRefsOf(text);
}

/**
 * Paths (relative to `gameDir`, with `/`) of every file the website needs
 * under /lib/: modules its scripts import and stylesheets its pages link,
 * with what those import in turn. Throws when a website script, stylesheet
 * or page loads anything from the gated /play, when a /lib/ file is
 * missing, or when a relative reference leaves the game directory.
 */
export function libModules({ websiteDir, gameDir }) {
  const pending = [];
  for (const file of websiteFiles(websiteDir)) {
    for (const ref of refsOfWebsiteFile(file)) {
      if (refersToGame(ref)) {
        throw new Error(`${relative(websiteDir, file)} loads ${ref}: /play is gated, publish it under ${LIB_PREFIX} instead`);
      }
      if (ref.startsWith(LIB_PREFIX)) pending.push(ref.slice(LIB_PREFIX.length).split(/[?#]/)[0]);
    }
  }
  const root = resolve(gameDir);
  const seen = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${rel} is outside ${gameDir}`);
    if (!existsSync(abs)) throw new Error(`${LIB_PREFIX}${rel} does not exist in ${gameDir}`);
    seen.add(rel);
    const text = readFileSync(abs, 'utf8');
    const refs = rel.endsWith('.css') ? cssRefsOf(text) : rel.endsWith('.js') ? importsOf(text) : [];
    for (const spec of refs) {
      if (!spec.startsWith('./') && !spec.startsWith('../') && !(rel.endsWith('.css') && !spec.startsWith('/') && !/^[a-z]+:/i.test(spec))) {
        throw new Error(`${rel} refers to ${spec}: only relative references can be published under ${LIB_PREFIX}`);
      }
      const target = relative(root, resolve(dirname(abs), spec.split(/[?#]/)[0])).split(sep).join('/');
      if (target.startsWith('..')) throw new Error(`${rel} refers to ${spec}, outside ${gameDir}`);
      pending.push(target);
    }
  }
  return [...seen].sort();
}
