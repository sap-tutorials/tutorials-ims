#!/usr/bin/env node
// Copilot preToolUse hook — port of .claude/hooks/block-full-test-suite.sh.
//
// BLOCK the full, in-process vitest suites locally — they peg the machine (concurrent
// worker pools) and take >10 min. The full suite runs in CI; locally, run a SCOPED test.
//
// BLOCKED (full in-process suites):
//   npm test / npm run test / npm run test:all / npm run test:a11y / npm run test:watch
//   npx vitest run --project unit|a11y   (and bare `vitest run` with no file arg)
// ALLOWED (pass through):
//   scoped runs:  npm test -- <pattern|path>   /   vitest run <path/to/file>
//   HTTP/remote:  test:smoke, test:e2e, test:hybrid, test:smoke:personalization, etc.
//
// Contract: JSON event on stdin; prints `{}` (no decision) or a deny decision on stdout.
// Keep the regexes in sync with the bash version.
'use strict';

const fs = require('node:fs');

const SHELL_TOOLS = /^(bash|powershell|shell|run_in_terminal|runInTerminal)$/i;

function readEvent() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function extractCommand(event) {
  const toolName = event.toolName ?? event.tool_name ?? '';
  if (toolName && !SHELL_TOOLS.test(toolName)) return '';
  let args = event.toolArgs ?? event.tool_input ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return args;
    }
  }
  return typeof args?.command === 'string' ? args.command : '';
}

function isScoped(norm) {
  if (/(npm (run )?test|run test:[a-z:]*) +-- +[^ -]/.test(norm)) return true;
  if (/vitest run +(-t|--testNamePattern|[^ -])/.test(norm)) return true;
  // `vitest run --project unit <file>` — project flag followed by a file/pattern.
  if (/vitest( run)? +--project +[a-z0-9-]+ +(-t|--testNamePattern|[^ -])/.test(norm)) return true;
  return false;
}

function isFullSuite(norm) {
  if (/(^|[;&|] *)(npm (run )?test( +--project +(unit|a11y))?|npm run test:all|npm run test:a11y|npm run test:watch)( |$)/.test(norm)) return true;
  if (/vitest( run)? +--project +(unit|a11y)( |$)/.test(norm)) return true;
  if (/(^|[;&|] *)(npx )?vitest( run)? *$/.test(norm)) return true;
  return false;
}

function decide(cmd) {
  // Strip a leading quiet-run wrapper so `quiet-run.ps1 npm test` is judged like `npm test`.
  const norm = cmd
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[;&|] *)(\.?[\\/])?(scripts[\\/])?quiet-run\.(sh|ps1) +/g, '$1');
  if (norm && isFullSuite(norm) && !isScoped(norm)) {
    return {
      permissionDecision: 'deny',
      permissionDecisionReason:
        'BLOCKED: the full local test suite is disallowed on this project — it pegs the machine and already runs in CI. ' +
        "Run a SCOPED test instead: 'npm test -- <file-or-pattern>' or 'npx vitest run <path/to/file>'. " +
        'Allowed remote suites: test:smoke / test:e2e / test:hybrid.',
    };
  }
  return {};
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(decide(extractCommand(readEvent()))));
}

module.exports = { decide, extractCommand };
