#!/usr/bin/env bash
# Checks that a commit of the fork is an exact upstream release plus the
# Lazurio overlay, and nothing else.
#
#   lazurio/fork-check.sh <upstream-tag> [<commit>]     (commit defaults to HEAD)
#
# Passes when:
#   - <upstream-tag> exists in garrytan/gbrain and has a stable-v<version> tag
#     on the same commit (the upstream stable channel promoted it);
#   - <upstream-tag> is an ancestor of <commit> (history kept, no rewrite);
#   - the only paths where <commit> differs from <upstream-tag> are the
#     overlay paths listed in OVERLAY below, the paths of the fork's code
#     patches (lazurio/patches.list) and package.json, where only its
#     "version" line may differ (the fork release's own version).
set -euo pipefail
TAG=$1; COMMIT=${2:-HEAD}
OVERLAY=(lazurio '\.github/workflows/lazurio-upstream-check\.yml')
UPSTREAM=https://github.com/garrytan/gbrain.git
fail() { echo "FAIL: $*"; exit 1; }
patched=$(git show "$COMMIT:lazurio/patches.list" 2> /dev/null | grep -v '^#' | cut -f2 | tr ' ' '\n' | grep -v '^$' || true)

git fetch -q "$UPSTREAM" "refs/tags/$TAG:refs/tags/$TAG" "refs/tags/stable-${TAG}:refs/tags/stable-${TAG}" 2> /dev/null \
  || fail "$TAG or stable-$TAG is not an upstream tag"
[ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse "stable-$TAG^{commit}")" ] \
  || fail "stable-$TAG does not point at $TAG"
git merge-base --is-ancestor "$TAG" "$COMMIT" || fail "$TAG is not an ancestor of $COMMIT"
pattern=$(printf '%s|' "${OVERLAY[@]}"); pattern="^(${pattern%|})(/|$)"
extra=$(git diff --name-only "$TAG" "$COMMIT" | grep -Ev "$pattern" \
  | grep -vxF -e package.json ${patched:+$(printf -- '-e %s ' $patched)} || true)
[ -z "$extra" ] || fail "$COMMIT differs from $TAG outside the overlay and the listed patches:
$extra"
version_only=$(git diff -U0 "$TAG" "$COMMIT" -- package.json | bash "$(dirname "$0")/package-diff.sh")
[ -z "$version_only" ] || fail "package.json differs from $TAG beyond its version:
$version_only"
echo "ok: $(git rev-parse --short "$COMMIT") = upstream $TAG ($(git rev-parse --short "$TAG^{commit}"), stable) + overlay [${OVERLAY[*]}] + $(printf '%s\n' $patched | grep -c . || true) patched paths (lazurio/patches.list)"
git diff --stat "$TAG" "$COMMIT" | tail -1
