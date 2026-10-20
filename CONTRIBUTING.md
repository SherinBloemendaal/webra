# Contributing to WebRA

Thanks for your interest. Bug reports, ideas and pull requests are welcome.
For anything larger than a small fix, open an issue first so we can agree on
the approach before you spend time on it.

Security problems are never reported in public: see [SECURITY.md](SECURITY.md).

## Setup

You need:

- a Rust toolchain (stable) with the `wasm32-unknown-unknown` target;
- `wasm-pack` 0.13.1 (the version CI builds with);
- Node.js 22 and npm;
- Python 3.12 (the data generators in `tools/` and a static file server).

```bash
git clone https://github.com/SherinBloemendaal/webra.git
cd webra
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.13.1 --locked
npm ci
npm run build:wasm
python3 -m http.server 8080 --directory apps/game
```

Then open <http://localhost:8080> in a browser with WebGPU support. For
accounts, online play and the full headers, run the Worker locally: see
[docs/deploy.md](docs/deploy.md), "Local development". The README's
"Getting started" lists more commands.

### Windows: symbolic links

The repository contains a symbolic link (`apps/game/protocol` points to
`packages/protocol/src`). Git for Windows checks symbolic links out as plain
text files unless they are enabled, and then the game cannot load its
protocol modules. Enable Developer Mode in Windows (or run Git as an
administrator) and clone with symbolic links on:

```bash
git clone -c core.symlinks=true https://github.com/SherinBloemendaal/webra.git
```

In an existing clone: `git config core.symlinks true`, then
`git checkout -- apps/game/protocol`. WSL avoids the problem altogether.

## Checks

CI runs these on every pull request; run the ones that cover your change
before you push:

| What | Command |
|------|---------|
| Rust formatting | `cargo fmt --all -- --check` |
| Rust lints | `cargo clippy --workspace --profile ci --tests --examples -- -D warnings` |
| Engine tests | `cargo test --workspace --profile ci` |
| WGSL shaders | `cargo run -p shader-check` |
| WebAssembly build | `npm run build:wasm` |
| JavaScript checks | `npm run check:js` |
| Protocol, server, web and tools tests | `npm run test:protocol`, `npm run test:server`, `npm run test:web`, `npm run test:tools` |
| Site build | `npm run build` |
| Generated files in sync | the generators in `tools/` (see `.github/workflows/ci.yml`, job "Rules and tables"), then `git diff` shows nothing |

The server and web tests need the WebAssembly build (`npm run build:wasm`)
first. Prefer running the tests for the part you changed while you work
(`node --test apps/server/test/<file>.test.mjs`) and the full set once at
the end. [docs/ci.md](docs/ci.md) describes the CI jobs.

Generated files (for example `engine/rules.json`, `apps/game/js/content/tables.js`,
`apps/game/missions/`) are never edited by hand: change the generator or its
input and run it again. Each one names its generator in its header.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
**with a scope**; release-please builds the version and the changelog from
them.

```
<type>(<scope>): <short imperative summary>
```

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `ci`,
  `build`, `style`, `revert`.
- Scopes: `game`, `engine`, `server`, `website`, `editor`, `protocol`,
  `docs`, `repo`, `deps`.
- Summary in the imperative, lowercase, no trailing period, about 72
  characters at most. Explain the why in the body when it is not obvious.

Examples: `fix(server): refuse invite codes of a closed lobby`,
`feat(editor): mirror spawns when a map is mirrored`.

## Content and licensing

- **No original game files.** Never commit, attach or upload files of
  the original commercial game or other commercial games, or anything
  extracted or derived from them: `.mix`, `.shp`, `.aud`, `.vqa`, `.pal`,
  `.tmp`/`.tem`/`.sno`/`.int`/`.des`, the game's `.ini` files, sprites or
  sounds converted to PNG, WAV or base64, screenshots of the original art
  used as assets. Players load these from their own copy in the browser.
  Tests use synthetic data made in the test.
- **No private maps or other people's content** without their permission
  and a licence that allows it.
- WebRA is GPL-3.0-or-later ([LICENSE](LICENSE), [NOTICE](NOTICE)). By
  contributing you agree that your contribution is licensed under the same
  terms. Code or data taken from OpenRA keeps its attribution: name the
  OpenRA source in a comment or in `data/CATALOG.md`. New third-party
  dependencies that end up in what the site ships need an entry in
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Pull requests

- Keep a pull request to one change; split unrelated work.
- Add or update tests for what you change, and update the docs in `docs/`
  that describe it (`docs/contracts.md` for interfaces, `docs/security.md`
  for anything security related).
- Pull requests from forks run CI on GitHub-hosted runners without access to
  secrets; the deploy only runs from `main`.
