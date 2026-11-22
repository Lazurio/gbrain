#!/usr/bin/env bash
# Whether the fork's code patches (lazurio/patches.list) carry cleanly onto
# a newer upstream stable tag, so taking upstream is never blocked by them.
#
#   lazurio/upstream-check.sh <current-upstream-tag> <newer-upstream-tag> [--test]
#
# In a temporary worktree at <newer-upstream-tag>, it cherry-picks each patch
# of lazurio/patches.list (found by its exact subject in
# <current-upstream-tag>..HEAD), in the listed order. It fails on the first
# patch that does not apply cleanly, or that changes a path outside its line.
# With --test it then installs the dependencies there and runs the patches'
# own tests. The worktree is removed at the end either way; nothing is
# pushed. Run it before each release and whenever upstream promotes a new
# stable tag; lazurio/README.md says what to do when it fails.
set -euo pipefail
CURRENT=$1; NEWER=$2; TEST=${3:-}
UPSTREAM=https://github.com/garrytan/gbrain.git
here=$(git rev-parse --show-toplevel)
list="$here/lazurio/patches.list"
fail() { echo "FAIL: $*"; exit 1; }

for tag in "$CURRENT" "$NEWER"; do
  git -C "$here" rev-parse -q --verify "refs/tags/$tag" > /dev/null \
    || git -C "$here" fetch -q "$UPSTREAM" "refs/tags/$tag:refs/tags/$tag" 2> /dev/null \
    || fail "$tag is not an upstream tag"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/gbrain-upstream-check.XXXXXX")
cleanup() { git -C "$here" worktree remove --force "$work/tree" > /dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
git -C "$here" worktree add -q --detach "$work/tree" "$NEWER"

tests=()
while IFS=$'\t' read -r subject paths; do
  case "$subject" in ''|'#'*) continue ;; esac
  commit=$(git -C "$here" log --format='%H%x09%s' --no-merges "$CURRENT..HEAD" \
    | awk -F'\t' -v s="$subject" '$2 == s { print $1; exit }')
  [ -n "$commit" ] || fail "no commit with subject '$subject' in $CURRENT..HEAD"
  changed=$(git -C "$here" diff-tree --no-commit-id --name-only -r "$commit")
  for path in $changed; do
    case " $paths " in *" $path "*) ;; *) fail "'$subject' changes $path, which its line does not list" ;; esac
  done
  # A committer for the throwaway picks: a CI runner or a fresh home has no git identity.
  git -C "$work/tree" -c user.name='Lazurio upstream check' -c user.email='upstream-check@lazurio.invalid' \
    cherry-pick -x "$commit" > "$work/pick.log" 2>&1 \
    || { cat "$work/pick.log"; fail "'$subject' does not apply cleanly onto $NEWER"; }
  echo "ok: $subject"
  for path in $paths; do case "$path" in test/*) tests+=("$path") ;; esac; done
done < "$list"

if [ "$TEST" = "--test" ]; then
  (cd "$work/tree" && bun install --frozen-lockfile > "$work/install.log" 2>&1) \
    || { tail -20 "$work/install.log"; fail "bun install failed on $NEWER"; }
  (cd "$work/tree" && bun test "${tests[@]}") || fail "the patches' tests fail on $NEWER"
fi
echo "ok: the patch set carries onto upstream $NEWER ($(git -C "$here" rev-parse --short "$NEWER^{commit}"))"
