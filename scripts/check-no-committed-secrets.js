#!/usr/bin/env node
// scripts/check-no-committed-secrets.js
//
// #887 backstop. Scans the tracked file tree for known-bad literal secret
// values and fails if any are present. Runs in CI on every push; also
// runnable locally (`node scripts/check-no-committed-secrets.js`).
//
// KEEP THIS LIST SHORT AND SPECIFIC. It is a tripwire for known-exposed
// values (rotated after #887), not a general-purpose secret scanner —
// gitleaks / trufflehog are better for that. The point of the tripwire
// is that if someone accidentally reintroduces one of these values via
// a doc revert or a copy-paste from an old branch, the build fails
// loudly instead of silently reopening the vulnerability.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const KNOWN_BAD_VALUES = [
  // #887 — DEV CONTENT_API_KEY that was committed to the repo + published docs
  // site before rotation. After the rotation the DEV key is a fresh random
  // string in the BTP credstore; the string below is retained only so its
  // reintroduction triggers a fail.
  'tutorials-content-publish-2024',
];

const IGNORE_PATHS = [
  // The scanner itself contains the literal so grep-for-grep bootstrap works.
  'scripts/check-no-committed-secrets.js',
  // The docs describe what the tripwire does; the value only appears as a
  // description of what NOT to write, not as a working credential.
  'docs/developers/operations/rotate-content-api-key.md',
];

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter(f => !IGNORE_PATHS.includes(f));

let hits = 0;
for (const file of trackedFiles) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    // Binary or unreadable — skip (git ls-files includes both).
    continue;
  }
  for (const needle of KNOWN_BAD_VALUES) {
    if (content.includes(needle)) {
      const lineNo = content.split('\n').findIndex(l => l.includes(needle)) + 1;
      console.error(`::error file=${file},line=${lineNo}::Known-exposed secret string found: ${needle.slice(0, 6)}…`);
      hits += 1;
    }
  }
}

if (hits > 0) {
  console.error(`\ncheck-no-committed-secrets: ${hits} occurrence(s) found. See docs/developers/operations/rotate-content-api-key.md.`);
  process.exit(1);
}
console.log(`check-no-committed-secrets: ok — scanned ${trackedFiles.length} tracked files against ${KNOWN_BAD_VALUES.length} known-bad value(s).`);
