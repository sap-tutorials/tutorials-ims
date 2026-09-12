#!/usr/bin/env bash
# quiet-run: run a noisy command, keep the FULL output on disk, but print only a
# compact summary — exit code, matched error/failure lines, and the last N lines.
#
# Purpose: keep tens of thousands of tokens of scrollback (mbt build, cf deploy,
# npm test, cf logs, build:all) OUT of an AI agent's context window while still
# surfacing the ~20 lines that actually matter. Drill into the full log only if
# the summary is not enough.
#
# Usage:
#   scripts/quiet-run.sh <command> [args...]
#   scripts/quiet-run.sh npm test
#   scripts/quiet-run.sh cf deploy mta_archives/foo.mtar -e ../deploy/dev.mtaext -f
#
# Env knobs:
#   QUIET_TAIL=15        lines of trailing output to show   (default 15)
#   QUIET_MATCH=40       max matched error lines to show    (default 40)
#   QUIET_LOG_DIR=.quiet-logs   where full logs are written (default .quiet-logs)
#
# Exits with the wrapped command's own exit code, so it is safe in && chains and CI.
#
# Note: runs the command directly (no tee) — Git Bash on Windows drops streamed
# stdout during long-silent phases; writing straight to a file avoids that.
# Does not support shell pipes/builtins in the wrapped command; wrap those in a
# script or `bash -c '...'` first.

set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "quiet-run: no command given" >&2
  echo "usage: scripts/quiet-run.sh <command> [args...]" >&2
  exit 2
fi

TAIL_LINES="${QUIET_TAIL:-15}"
MATCH_LINES="${QUIET_MATCH:-40}"
LOG_DIR="${QUIET_LOG_DIR:-.quiet-logs}"

mkdir -p "$LOG_DIR"
ts="$(date +%Y%m%d-%H%M%S)"
log="$LOG_DIR/run-$ts-$$.log"

# Patterns worth surfacing: generic failures plus this repo's known deploy tells.
pattern='error|fail(ed|ure)?|panic|exception|traceback|cannot|unable to|in cds\.deploy|ASSERT_[A-Z_]+|Minification failed|OOM|out of memory|crash|ENOENT|EISDIR|401|403|404|5[0-9][0-9] '

"$@" >"$log" 2>&1
rc=$?

echo "=== quiet-run: exit=$rc  cmd: $* ==="
echo "--- matched error/failure lines (max $MATCH_LINES) ---"
if ! grep -nEi "$pattern" "$log" | head -n "$MATCH_LINES"; then
  echo "(none matched)"
fi
echo "--- last $TAIL_LINES lines ---"
tail -n "$TAIL_LINES" "$log"
echo "=== full log: $log  ($(wc -l < "$log" | tr -d ' ') lines) ==="

exit "$rc"
