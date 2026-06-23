#!/usr/bin/env bash
# Single-process migration runner. Bypasses cds bind --exec (5-deep wrapper chain)
# AND avoids tee piping (Git Bash on Windows drops stdout during long-silent phases).
#
# Both source AND target HANA creds come from env vars / staged files.
# Output goes DIRECTLY to a log file via `node > $LOG 2>&1`. No tee.
#
# Watch progress in another terminal:  tail -f .migration-data/migration-*.log

set -euo pipefail

cd "$(dirname "$0")/.."

LOCKFILE=".migration-data/migration.pid"
LOGDIR=".migration-data"
mkdir -p "$LOGDIR"

# --- Safety: refuse to start if another migrator is already running ---
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "${OLD_PID:-}" ] && powershell -NoProfile -Command "Get-Process -Id $OLD_PID -ErrorAction SilentlyContinue" 2>/dev/null | grep -q "$OLD_PID"; then
    echo "✗ Another migrator (PID $OLD_PID) is already running."
    echo "  taskkill /F /PID $OLD_PID && rm $LOCKFILE"
    exit 1
  fi
  echo "⚠ Stale lock file — removing"
  rm -f "$LOCKFILE"
fi

# --- Credentials ---
if [ -z "${IMS_HANA_CREDENTIALS:-}" ]; then
  if [ -f "/tmp/ims-prod-creds.json" ]; then
    export IMS_HANA_CREDENTIALS="$(cat /tmp/ims-prod-creds.json)"
    echo "✓ Loaded IMS_HANA_CREDENTIALS from /tmp/ims-prod-creds.json"
  else
    echo "✗ /tmp/ims-prod-creds.json missing"
    exit 1
  fi
fi
if [ -z "${CAP_HANA_CREDENTIALS:-}" ]; then
  if [ -f "/tmp/cap-hana-creds.json" ]; then
    export CAP_HANA_CREDENTIALS="$(cat /tmp/cap-hana-creds.json)"
    echo "✓ Loaded CAP_HANA_CREDENTIALS from /tmp/cap-hana-creds.json"
  else
    echo "✗ /tmp/cap-hana-creds.json missing — run:"
    echo "    cf service-key tutorials-hana tutorials-hana-key | sed -n '/{/,/^}/p' | jq '.credentials // .' > /tmp/cap-hana-creds.json"
    exit 1
  fi
fi

LOG="$LOGDIR/migration-$(date -u +%Y-%m-%dT%H%M%SZ).log"
echo "✓ Logging to $LOG"
echo ""
echo "Args: $*"
echo ""
echo "Migration running. To watch progress LIVE, open another terminal:"
echo "    tail -f $LOG"
echo ""
echo "This window will print only the final status when migration completes."
echo "Migration takes 45-90 minutes for a full TaskRecords pull."
echo ""

# --- Run migrator: stdout/stderr directly to file, no tee ---
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT INT TERM

node scripts/migrate-from-hana.js "$@" > "$LOG" 2>&1
EXIT_CODE=$?

echo ""
echo "=== Migration finished — last 30 lines of log ==="
tail -30 "$LOG"
echo ""
if [ "$EXIT_CODE" = "0" ]; then
  echo "✓ Migration completed successfully (exit 0)"
else
  echo "✗ Migration exited with code $EXIT_CODE — full log: $LOG"
fi
exit $EXIT_CODE
