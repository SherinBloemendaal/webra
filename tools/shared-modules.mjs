// The game modules the website imports. While the play gate is on, the
// Worker serves /play only to accounts that may play (docs/security.md), but
// the account page has to work for signed-out visitors and it uses the
// game's account client and the protocol checks. tools/build-dist.mjs copies
// exactly the modules the website imports from /lib/ (and what they import,
// relatively) from apps/game into dist/lib/, keeping their layout, so the
// same source serves both and nothing else of the game becomes public.
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

function jsFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...jsFiles(p));
    else if (name.endsWith('.js')) files.push(p);
  }
  return files;
}

/**
 * Paths (relative to `gameDir`, with `/`) of every module the website needs
 * under /lib/. Throws when a website script imports the gated /play/ path
 * statically, when a /lib/ module is missing, or when a relative import
 * leaves the game directory.
 */
export function libModules({ websiteDir, gameDir }) {
  const pending = [];
  for (const file of jsFiles(websiteDir)) {
    for (const spec of importsOf(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('/play/')) {
        throw new Error(`${relative(websiteDir, file)} imports ${spec}: /play is gated, import it from ${LIB_PREFIX} instead`);
      }
      if (spec.startsWith(LIB_PREFIX)) pending.push(spec.slice(LIB_PREFIX.length));
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
    for (const spec of importsOf(readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`${rel} imports ${spec}: only relative imports can be published under ${LIB_PREFIX}`);
      const target = relative(root, resolve(dirname(abs), spec)).split(sep).join('/');
      if (target.startsWith('..')) throw new Error(`${rel} imports ${spec}, outside ${gameDir}`);
      pending.push(target);
    }
  }
  return [...seen].sort();
}
