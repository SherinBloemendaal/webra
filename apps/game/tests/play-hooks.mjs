// Module resolution hooks for tests of the website's scripts: they import the
// game's modules by their served path (/lib/js/..., the public copy that
// tools/build-dist.mjs makes; /play/js/... for the game itself), which maps
// to apps/game.
const GAME = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
  for (const prefix of ['/lib/', '/play/']) {
    if (specifier.startsWith(prefix)) return next(new URL(specifier.slice(prefix.length), GAME).href, context);
  }
  return next(specifier, context);
}
