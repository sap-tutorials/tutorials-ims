#!/usr/bin/env bash
# .claude/hooks/block-full-test-suite.sh
#
# PreToolUse(Bash) guard (#2585 follow-up / Tom's request 2026-10-07):
# BLOCK the full, in-process vitest suites locally — they peg the machine
# (concurrent worker pools) and take >10 min. The full suite runs in CI on
# the server side; locally, run a SCOPED test instead.
#
# BLOCKED (full in-process suites):
#   npm test / npm run test / npm run test:all / npm run test:a11y / npm run test:watch
#   npx vitest run --project unit|a11y   (and bare `vitest run` with no file arg)
# ALLOWED (pass through):
#   scoped runs:  npm test -- <pattern|path>   /   vitest run <path/to/file>
#   HTTP/remote:  test:smoke, test:e2e, test:hybrid, test:smoke:personalization
#   loadtest:*, test:a11y:lighthouse, test:a11y:summary, test:llm-ux
#
# Decision via exit code: 0 = allow, 2 = deny (stderr shown to the agent).
set -euo pipefail

input="$(cat)"
# Extract the Bash command string from the tool-call JSON.
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[ -z "$cmd" ] && exit 0

# Normalize whitespace for matching.
norm="$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')"

deny() {
  echo "BLOCKED: full local test suite is disallowed on this project — it pegs the machine and the full suite already runs in CI server-side." >&2
  echo "Run a SCOPED test instead: 'npm test -- <file-or-pattern>' or 'npx vitest run <path/to/file>'. Allowed remote suites: test:smoke / test:e2e / test:hybrid." >&2
  exit 2
}

# A command is "scoped" if it passes a file path or a -t/--testNamePattern filter
# to vitest (either `npm test -- <arg>` or `vitest run <arg>`).
is_scoped() {
  # `npm test -- X` / `npm run test -- X` with a non-flag arg after `--`
  if printf '%s' "$norm" | grep -Eq '(npm (run )?test|run test:[a-z:]*) +-- +[^ -]'; then return 0; fi
  # vitest run <path or -t pattern>
  if printf '%s' "$norm" | grep -Eq 'vitest run +(-t|--testNamePattern|[^ -])'; then return 0; fi
  return 1
}

# Full-suite invocations we block (only when NOT scoped).
is_full_suite() {
  printf '%s' "$norm" | grep -Eq '(^|[;&|] *)(npm (run )?test( +--project +(unit|a11y))?|npm run test:all|npm run test:a11y|npm run test:watch)( |$)' && return 0
  printf '%s' "$norm" | grep -Eq 'vitest( run)? +--project +(unit|a11y)( |$)' && return 0
  # bare `vitest run` / `vitest` with no trailing file/pattern
  printf '%s' "$norm" | grep -Eq '(^|[;&|] *)(npx )?vitest( run)? *$' && return 0
  return 1
}

if is_full_suite && ! is_scoped; then
  deny
fi
exit 0
