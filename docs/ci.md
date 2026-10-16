# CI

`.github/workflows/ci.yml` runs on pull requests (not on the release PR's
`release-please--...` branch), on manual dispatch, and on every push to
`main` through `deploy.yml`, which calls it as a reusable workflow before it
deploys (see [deploy.md](deploy.md)). All jobs run on the self-hosted ARC
runner scale sets `small`, `medium`, `large` and `enormous` (at most three
`enormous` runners), with a minimal Ubuntu image: every job installs what it
needs.

## Jobs

| Job | Runner | What it checks |
|---|---|---|
| Changed paths | small | Decides whether the engine and shader jobs run (below) |
| Engine | enormous | `cargo fmt`, `cargo clippy` (with tests and examples), `cargo test` (lib and bins, then doctests), a headless AI vs AI match |
| WGSL shaders | small | `cargo run -p shader-check` |
| Rules and tables | small | Every generator in `tools/` reproduces the committed files |
| Web | medium | `npm run build:wasm`, the JS checks and the protocol, server, web and tools tests, `test:luastack` |

The engine job builds with the `ci` profile (`Cargo.toml`): release with
`panic = "unwind"`. Tests need unwinding anyway, so clippy, the test binary
and the AI match example share one build of the dependencies; with the release
profile (`panic = "abort"`) the example would rebuild everything. The game's
wasm build keeps the release profile.

The web job builds the Lua stack probe (`test:luastack`, a second wasm32
release build with the `stack-probe` feature) in the background: it waits
for wasm-pack's cargo build (they share `target/`), then compiles while
wasm-opt and the JS tests run. It then uploads `apps/game/pkg` as the
artifact `webra-pkg` (kept one day); Deploy ships exactly that build.

wasm-pack is pinned (0.13.1, a prebuilt binary through
`taiki-e/install-action`); it also decides the wasm-bindgen CLI and the
wasm-opt that run. Change the version in `ci.yml` and in the README together.

## Release commits

A release-please release commit only bumps versions in 11 files (the
manifest, `CHANGELOG.md`, the package.json files, `engine/Cargo.toml`,
`packages/protocol/src/version.js` and the two lock files). For those the
engine and shader jobs are skipped: they passed on the commit before, and
nothing they test changed. `.github/scripts/engine-relevant.sh` decides it:
every changed file must be one of those 11, and `Cargo.lock` and
`engine/Cargo.toml` may differ only in the `webra-sim` version. Anything
else runs the full CI. The web and data jobs always run; the protocol tests
check that every version file agrees, and the web job builds the wasm with the
new version for the deploy.

What is compared: on a push, everything the push brought; on a pull request,
the merge commit against the base branch; a manual run checks everything,
unless `changed_only` is set, which compares the tip commit with its parent.

## Concurrency

A newer push to a pull request cancels its older CI run. Pushes to `main`
are grouped per commit, so each push's CI finishes; only Deploy's deploy job
is serialized (deploy.md).
