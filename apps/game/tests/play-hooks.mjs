// Module resolution hooks for tests of the website's scripts: they import the
// game's modules by their served path (/play/js/...), which maps to apps/game.
const GAME = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/play/')) return next(new URL(specifier.slice('/play/'.length), GAME).href, context);
  return next(specifier, context);
}
