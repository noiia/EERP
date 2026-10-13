#!/usr/bin/env bash
# Prints the version of the build about to run: the latest vMAJOR.MINOR.PATCH tag
# with its minor bumped (patch reset), never below FLOOR (the versioning started
# at 0.101.0; older tags such as v0.0.3 predate it). A release is declared by
# pushing a tag by hand (e.g. v1.0.0) — builds then continue from it (1.1.0, …).
# Used by .github/workflows/test-build.yml; reads the tags of the current repo.
set -euo pipefail

FLOOR="${FLOOR:-0.101.0}"

latest="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sed 's/^v//' \
  | awk -F. '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/' | sort -V | tail -n1)"

# Below the floor (or no tag yet): the floor itself is the next version.
if [ -z "$latest" ] || [ "$(printf '%s\n%s\n' "$latest" "$FLOOR" | sort -V | tail -n1)" != "$latest" ]; then
  echo "$FLOOR"
  exit 0
fi
IFS=. read -r major minor _ <<<"$latest"
# At (or past) the floor: one more build. The floor is reached exactly once.
echo "$major.$((minor + 1)).0"
