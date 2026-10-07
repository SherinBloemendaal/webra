// Re-export of the shared multiplayer protocol (docs/contracts.md, section 1).
// apps/game/protocol is a symlink to packages/protocol/src in the repo; the
// build copies that directory to dist/play/protocol/, so this path works in
// local dev and in production.
export * from '../protocol/index.js';
