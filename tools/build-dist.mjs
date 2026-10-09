// Assembles dist/ for deployment (see docs/contracts.md, section 6):
//   dist/               apps/website (landing site)
//   dist/play/          apps/game (client, wasm package from wasm-pack)
//   dist/play/protocol/ packages/protocol/src
//   dist/lib/           the game modules the website imports (tools/shared-modules.mjs):
//                       /play is gated by the Worker, the account page is not
//   dist/version.json   { version, commit, build, builtAt }
//   dist/release-notes.json  CHANGELOG.md as data (tools/release-notes.mjs)
// No bundler: files are copied as they are.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeReleaseNotes } from './release-notes.mjs';
import { libModules } from './shared-modules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const website = join(root, 'apps/website');
const game = join(root, 'apps/game');
const protocol = join(root, 'packages/protocol/src');
const wasm = join(game, 'pkg/webra_sim_bg.wasm');

function fail(message) {
  console.error(`build-dist: ${message}`);
  process.exit(1);
}

if (!existsSync(wasm)) {
  fail(`missing ${relative(root, wasm)}. Run "npm run build:wasm" first.`);
}
for (const dir of [website, game, protocol]) {
  if (!existsSync(dir)) fail(`missing ${relative(root, dir)}`);
}

// Names never shipped from any source tree. Dotfiles (such as the .gitignore
// wasm-pack writes into pkg/) are skipped as well.
const SKIP_ALWAYS = new Set(['node_modules', 'package.json', '.DS_Store']);

/** Copy `from` into `to`, skipping excluded names and top-level dirs. */
function copyTree(from, to, skipTopLevel = new Set()) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      if (src === from) return true;
      const name = basename(src);
      if (name.startsWith('.') || SKIP_ALWAYS.has(name)) return false;
      const rel = relative(from, src);
      return !skipTopLevel.has(rel.split(/[\\/]/)[0]);
    },
  });
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (for example a source tarball): fall back to CI env.
    return process.env.WEBRA_GIT_HASH || process.env.GITHUB_SHA || 'unknown';
  }
}

function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      const sub = countFiles(p);
      n += sub.n;
      bytes += sub.bytes;
    } else {
      n++;
      bytes += s.size;
    }
  }
  return { n, bytes };
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

copyTree(website, dist);
// apps/game/protocol is a symlink to packages/protocol/src: copied as real files below.
copyTree(game, join(dist, 'play'), new Set(['tests', 'protocol']));
copyTree(protocol, join(dist, 'play/protocol'));

// The website's account and admin pages import these at /lib/ (same files as
// under /play/, same layout, so their relative imports resolve the same way).
let lib;
try {
  lib = libModules({ websiteDir: website, gameDir: game });
} catch (err) {
  fail(err.message);
}
for (const rel of lib) {
  const to = join(dist, 'lib', rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(game, rel), to, { dereference: true });
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = gitCommit();
// `build` equals the engine's version() string; multiplayer sessions and the
// website compare it, because only identical builds stay in lockstep.
const info = { version, commit, build: `${version}+${commit.slice(0, 8)}`, builtAt: new Date().toISOString() };
writeFileSync(join(dist, 'version.json'), `${JSON.stringify(info, null, 2)}\n`);

// Release notes for the game's "What's new" dialog and the website's /changelog.
// The running version must have notes, otherwise players never see them.
const notes = writeReleaseNotes(join(root, 'CHANGELOG.md'), join(dist, 'release-notes.json'));
if (!notes.releases.some((r) => r.version === version)) {
  fail(`CHANGELOG.md has no release ${version} (package.json); release-please writes both together.`);
}

const total = countFiles(dist);
console.log(
  `build-dist: dist/ ready (webra ${info.version}, commit ${info.commit.slice(0, 12)}): ` +
    `${total.n} files, ${(total.bytes / 1024).toFixed(0)} KiB, ${lib.length} modules in lib/, release notes for ${notes.releases.length} release${notes.releases.length === 1 ? '' : 's'}`,
);
