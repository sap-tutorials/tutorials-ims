#!/bin/sh
# scripts/install-git-hooks.sh
#
# Installs the project's git hooks into the primary tree's .git/hooks/
# directory. Run once after cloning, or whenever the hooks under
# scripts/git-hooks/ change.
#
# Wired into npm via the `prepare` script (runs automatically on
# `npm install`).

set -e

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
HOOK_SRC="$REPO_ROOT/scripts/git-hooks"
# Use common-dir so this works from any worktree — git always points it
# at the primary tree's .git/.
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "$REPO_ROOT/.git")
HOOK_DEST="$GIT_COMMON_DIR/hooks"

if [ ! -d "$HOOK_SRC" ]; then
  echo "[install-git-hooks] scripts/git-hooks/ not found — skipping" >&2
  exit 0
fi

mkdir -p "$HOOK_DEST"

# Copy each hook script, make executable. We don't symlink: Windows
# git-bash doesn't follow symlinks the way *nix does, and a copy is
# fine for a 7-line install script.
COUNT=0
for hook in "$HOOK_SRC"/*; do
  name=$(basename "$hook")
  # Skip non-hook files (e.g. a README if we add one later).
  case "$name" in
    pre-commit|post-checkout|pre-push|commit-msg|post-merge|pre-rebase)
      cp "$hook" "$HOOK_DEST/$name"
      chmod +x "$HOOK_DEST/$name" 2>/dev/null || true
      COUNT=$((COUNT + 1))
      ;;
  esac
done

echo "[install-git-hooks] installed $COUNT hook(s) into $HOOK_DEST" >&2
