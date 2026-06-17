// Tiny test double for the `btp` CLI. Reads canned JSON from FAKE_BTP_RESPONSE
// (or a JSON-Lines map at FAKE_BTP_FIXTURE_FILE keyed by the joined args), echoes
// it on stdout, exits with FAKE_BTP_EXIT (default 0). Captures the actual args
// to FAKE_BTP_TRACE_FILE so tests can assert call shape.
'use strict';
const fs = require('node:fs');

const args = process.argv.slice(2);

if (process.env.FAKE_BTP_TRACE_FILE) {
  fs.appendFileSync(process.env.FAKE_BTP_TRACE_FILE, JSON.stringify(args) + '\n');
}

const exitCode = parseInt(process.env.FAKE_BTP_EXIT || '0', 10);

if (process.env.FAKE_BTP_STDERR) {
  process.stderr.write(process.env.FAKE_BTP_STDERR);
}

if (process.env.FAKE_BTP_SLEEP_MS) {
  // Sleep then exit; used by timeout tests. Output (if any) is written first
  // so the parent can still see partial stdout/stderr if it chooses to read.
  const sleepMs = parseInt(process.env.FAKE_BTP_SLEEP_MS, 10);
  setTimeout(() => process.exit(exitCode), sleepMs);
  return;
}

let perEntryExit = null;

if (process.env.FAKE_BTP_FIXTURE_FILE) {
  // JSON-Lines file: each line is { match: <substring of joined args>, response: <JSON value>,
  // stderr?: string, exit?: number }. First match wins. `response` is JSON-stringified to
  // stdout (string responses end up double-quoted JSON strings); `stderr` and `exit` let
  // tests model error paths per-call.
  const lines = fs.readFileSync(process.env.FAKE_BTP_FIXTURE_FILE, 'utf8').split('\n').filter(Boolean);
  const joined = args.join(' ');
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (joined.includes(entry.match)) {
      if (entry.response !== undefined) {
        process.stdout.write(
          typeof entry.response === 'string' ? entry.response : JSON.stringify(entry.response)
        );
      }
      if (entry.stderr) process.stderr.write(entry.stderr);
      if (typeof entry.exit === 'number') perEntryExit = entry.exit;
      break;
    }
  }
} else if (process.env.FAKE_BTP_RESPONSE) {
  process.stdout.write(process.env.FAKE_BTP_RESPONSE);
}

process.exit(perEntryExit !== null ? perEntryExit : exitCode);
