# CI

`.github/workflows/ci.yml` runs on pull requests (not on the release PR's
`release-please--...` branch), on manual dispatch, and on every push to
`main` through `deploy.yml`, which calls it as a reusable workflow before it
deploys (see [deploy.md](deploy.md)). Pushes and manual runs use the
self-hosted ARC runner scale sets `small`, `medium`, `large` and `enormous`
(at most three `enormous` runners), with a minimal Ubuntu image: every job
installs what it needs. Pull requests, including those from forks, run every
job on GitHub-hosted `ubuntu-latest` runners instead, so code from a pull
request never runs on the self-hosted runners (the Runner column below is the
self-hosted label).

Every job has `permissions: contents: read` only (the release job in
`release.yml` also writes contents and pull requests). Third-party actions are
pinned to a full commit SHA with the version in a comment;
`.github/dependabot.yml` proposes updates weekly for the actions, npm and
cargo. `dtolnay/rust-toolchain` is pinned to a commit of its `stable` branch
and therefore names `toolchain: stable` as an input.

## Jobs

| Job | Runner | What it checks |
|---|---|---|
| Changed paths | small | Decides whether the engine and shader jobs run (below) |
| Engine | enormous | `cargo fmt`, `cargo clippy` (with tests and examples), `cargo test` (unit tests and doctests; builds every example), a headless AI vs AI match with the example it built |
| WGSL shaders | small | `cargo run -p shader-check` |
| Rules and tables | small | Every generator in `tools/` reproduces the committed files |
| Web | medium | `npm run build:wasm`, the JS checks and the protocol, server, web and tools tests, `test:luastack` |

The engine job builds with the `ci` profile (`Cargo.toml`): release with
`panic = "unwind"`. Tests need unwinding anyway, so the test binary and the
examples share one build of the dependencies; with the release profile
(`panic = "abort"`) the examples would need a second one. One `cargo test`
compiles the test binary, the lib and the examples side by side, and the AI
match runs `target/ci/examples/ai_vs_ai` directly: a later `cargo build` or
`cargo run -p webra-sim` would compile the engine again (cargo gives
`cargo build` and `cargo test` units different hashes, and `-p` other
features than `--workspace`). The game's wasm build keeps the release
profile.

The web job builds the Lua stack probe (`test:luastack`, a second wasm32
release build with the `stack-probe` feature) in the background: it waits
for wasm-pack's cargo build (they share `target/`), then compiles while
wasm-opt and the JS tests run. Right after wasm-pack, the job uploads `apps/game/pkg` as the
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
is serialized (deploy.md). Manual runs are grouped by branch: two manual
Deploy runs on `main` share `ci-Deploy-refs/heads/main`, so the second
cancels the first one's CI (and so its deploy), and two manual CI runs on one
branch do the same.

The skip is fail-safe: the engine and shader jobs run unless the changes job
says `false`, and a failing script fails the changes job (and so CI).

Deploy's deploy job checks that its commit is still the tip of `main` with
`git ls-remote`; when that command fails, the deploy fails instead of being
skipped (deploy.md).
