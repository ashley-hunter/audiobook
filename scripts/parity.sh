#!/usr/bin/env bash
# Proves a change did not alter what the home screen is.
#
#   npm run parity [ref]        # ref defaults to HEAD
#
# Builds the given ref in a throwaway worktree, runs the same harness against
# it and against the working tree, and compares both the markup of the two
# lists and the screenshots of four states. Any difference is reported and the
# script fails, so "it looks the same" is something the machine says rather
# than something we hope.
set -euo pipefail

ref="${1:-HEAD}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)/before"
out="$(mktemp -d)"

cleanup() {
  git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$root" worktree add --quiet --detach "$work" "$ref"
ln -sfn "$root/node_modules" "$work/node_modules"
cp "$root/test/parity.js" "$work/test/parity.js"

echo "Before ($ref):"
node "$work/test/parity.js" "$out/before.txt" "$work" | sed 's/^/  /'
echo "After (working tree):"
node "$root/test/parity.js" "$out/after.txt" "$root" | sed 's/^/  /'

echo
if diff -u "$out/before.txt" "$out/after.txt"; then
  echo "Markup identical."
else
  echo "Markup differs - see the diff above."
  exit 1
fi

echo
node "$root/test/parity-pixels.js" "$out/before.txt" "$out/after.txt"
