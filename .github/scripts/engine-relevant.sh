#!/bin/bash
# Usage: engine-relevant.sh [<base commit> [<head commit, default HEAD>]]
# Prints engine_relevant=true or engine_relevant=false (the CI "changes" job
# appends it to $GITHUB_OUTPUT). false only when every file that changed from
# <base> to <head> is one of the files a release-please release commit touches
# (release-please-config.json, release.yml) and the two Rust manifests among
# them changed nothing but the webra-sim version. Anything else, an empty
# base or a base that cannot be read means true: the engine and shader jobs run.
set -uo pipefail

relevant() { echo "engine_relevant=true"; echo "Engine jobs run: $1" >&2; exit 0; }

base=${1:-}
head=${2:-HEAD}
[ -n "$base" ] || relevant "no base commit to compare with"
[ -z "${base//0/}" ] && relevant "no previous commit (new branch)"
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch --no-tags --quiet --depth=1 origin "$base" 2>/dev/null || relevant "base $base not fetchable"
fi
files=$(git diff --name-only "$base" "$head") || relevant "git diff failed"
[ -n "$files" ] || relevant "no changed files"

# The 11 files of a release commit (release-please-config.json: the manifest,
# the changelog and the extra-files; release.yml: the two lock files).
allow='^(\.release-please-manifest\.json|CHANGELOG\.md|Cargo\.lock|package-lock\.json|package\.json|engine/Cargo\.toml|apps/game/package\.json|apps/server/package\.json|apps/website/package\.json|packages/protocol/package\.json|packages/protocol/src/version\.js)$'
other=$(grep -v -E "$allow" <<< "$files")
[ -z "$other" ] || relevant "changed outside the release files: $(tr '\n' ' ' <<< "$other")"

# A file at a commit with the webra-sim version replaced by a placeholder:
# Cargo.lock's version line right after name = "webra-sim", engine/Cargo.toml's
# version line in [package]. The two sides must then be identical.
lock_norm() {
  git show "$1:Cargo.lock" | awk '
    prev == "name = \"webra-sim\"" && /^version = / { print "version = <webra-sim>"; prev = $0; next }
    { print; prev = $0 }'
}
toml_norm() {
  git show "$1:engine/Cargo.toml" | awk '
    /^\[/ { section = $0 }
    section == "[package]" && /^version *= / { print "version = <webra-sim>"; next }
    { print }'
}
if grep -qx 'Cargo.lock' <<< "$files"; then
  [ "$(lock_norm "$base")" = "$(lock_norm "$head")" ] || relevant "Cargo.lock changed more than the webra-sim version"
fi
if grep -qx 'engine/Cargo.toml' <<< "$files"; then
  [ "$(toml_norm "$base")" = "$(toml_norm "$head")" ] || relevant "engine/Cargo.toml changed more than its version"
fi

echo "engine_relevant=false"
echo "Only release version files changed: engine and shader jobs are skipped." >&2
