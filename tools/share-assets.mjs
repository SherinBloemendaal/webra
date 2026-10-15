// Files the website and the game share in dist/ (tools/build-dist.mjs runs
// this after copying the trees): the logo under /lib/brand/ and one copy of
// the self-hosted fonts under /lib/fonts/.
//
// The logo (apps/game/brand, tools/gen-brand.mjs) is published whole, so
// every variant has a public URL (the website links some of them; the
// game keeps its own brand/ copy behind the play gate).
//
// The fonts: The sources keep relative references (apps/game/css/fonts.css
// loads ../fonts/*.woff2, the pages preload fonts/*.woff2), so the game also
// runs from a plain static server on apps/game; in dist/ the game's
// references point at /lib/fonts/ instead and dist/play/fonts/ is dropped,
// so a player who opened the website already has the fonts in the cache.
// /lib/ is public (no play gate) and same-origin, so the game's COEP
// require-corp and the CSP's font-src 'self' allow it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHARED_FONTS = '/lib/fonts/';

/** Copy apps/game/brand to dist/lib/brand. Returns the number of files. */
export function shareBrand({ dist, brandDir }) {
  const to = join(dist, 'lib/brand');
  mkdirSync(to, { recursive: true });
  const files = readdirSync(brandDir).filter((f) => !f.startsWith('.'));
  for (const f of files) cpSync(join(brandDir, f), join(to, f));
  return files.length;
}

/** Point a stylesheet's `../fonts/` URLs at /lib/fonts/. */
export function rewriteFontCss(css) {
  return css.replace(/url\(\s*(['"]?)\.\.\/fonts\//g, `url($1${SHARED_FONTS}`);
}

/** Point a page's `<link ... href="fonts/...">` (preloads) at /lib/fonts/. */
export function rewriteFontLinks(html) {
  return html.replace(/(<link\b[^>]*\shref=)(["'])(?:\.\/)?fonts\//g, `$1$2${SHARED_FONTS}`);
}

/** The /lib/fonts/ files a stylesheet or page refers to. */
export function sharedFontRefs(text) {
  return [...text.matchAll(/\/lib\/fonts\/([^'")\s?#]+)/g)].map((m) => m[1]);
}

/**
 * Share the game's fonts in `dist`: copy apps/game/fonts to dist/lib/fonts,
 * rewrite the game's font sheet and pages, drop dist/play/fonts. Throws when
 * a rewritten reference has no file. Returns `{ files, rewritten }`.
 */
export function shareFonts({ dist, fontsDir }) {
  const lib = join(dist, 'lib/fonts');
  mkdirSync(lib, { recursive: true });
  const files = readdirSync(fontsDir).filter((f) => !f.startsWith('.'));
  for (const f of files) cpSync(join(fontsDir, f), join(lib, f));
  const rewritten = [];
  const play = join(dist, 'play');
  const targets = [
    ['css/fonts.css', rewriteFontCss],
    ['index.html', rewriteFontLinks],
    ['editor/index.html', rewriteFontLinks],
  ];
  for (const [rel, fn] of targets) {
    const file = join(play, rel);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = fn(before);
    if (after !== before) {
      writeFileSync(file, after);
      rewritten.push(rel);
    }
    if (/\.\.\/fonts\/|href=["'](?:\.\/)?fonts\//.test(after)) throw new Error(`play/${rel} still loads fonts from /play/fonts/`);
    for (const name of sharedFontRefs(after)) if (!existsSync(join(lib, name))) throw new Error(`play/${rel} loads ${SHARED_FONTS}${name}, which is not in apps/game/fonts`);
  }
  rmSync(join(play, 'fonts'), { recursive: true, force: true });
  return { files: files.length, rewritten };
}
