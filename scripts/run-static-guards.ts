#!/usr/bin/env tsx
/**
 * Run all static guard checks and collect failures.
 *
 * Unlike the `&&`-chained postbuild:apps script, this runs every check
 * to completion, then reports all failures at once. Prevents death-by-a-thousand-cuts
 * where developers fix one check only to see a different one fail on the next push.
 */

import { spawnSync } from 'child_process';

const checks = [
  'tsx scripts/check-build-collisions.ts',
  'tsx scripts/check-icon-imports.ts',
  'tsx scripts/check-island-ui5-imports.ts',
  'tsx scripts/check-xs-app-mta.ts',
  'tsx scripts/check-public-endpoints.ts',
  'tsx scripts/check-srv-qa-cp-list.ts',
  'tsx scripts/check-srv-qa-route-drift.ts',
  'tsx scripts/check-srv-qa-dep-parity.ts',
  'tsx scripts/check-slug-lookups.ts',
  'tsx scripts/check-ui5-controller-extensions.ts',
  'tsx scripts/check-kg-meta-formatters-mirror.ts',
  'tsx scripts/check-csrf-clients.ts',
  'npm run check:graphql-breaking',
];

// Guards that support a `--fix` flag. Only mechanically-derivable,
// zero-judgment fixes are auto-fixable: copying an authoritative source
// over its mirror, or adding a fully-determined import. Guards whose fix
// needs human judgment (slug-canonical markers, code changes) are NOT here.
const FIXABLE = new Set([
  'scripts/check-icon-imports.ts',
  'scripts/check-kg-meta-formatters-mirror.ts',
]);

const FIX = process.argv.includes('--fix');

interface Result {
  name: string;
  pass: boolean;
}

function getName(cmd: string): string {
  return cmd.replace(/^.*\//g, '').replace(/\.ts.*/, '').replace(/^npm run /, '');
}

function runCheck(cmd: string): Result {
  const name = getName(cmd);
  const supportsFix = FIX && [...FIXABLE].some((f) => cmd.includes(f));
  const fullCmd = supportsFix ? `${cmd} --fix` : cmd;
  const result = spawnSync('sh', ['-c', fullCmd], {
    stdio: 'inherit',
  });
  return {
    name,
    pass: result.status === 0,
  };
}

function main() {
  const startTime = Date.now();
  console.log(
    `\n[static-guards] Running ${checks.length} checks${FIX ? ' (--fix: auto-applying safe fixes)' : ''}...\n`
  );

  const results = checks.map(runCheck);
  const failures = results.filter((r) => !r.pass);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.length - failures.length;

  console.log(
    `\n[static-guards] ${passed}/${results.length} checks passed (${elapsed}s)`
  );

  if (failures.length > 0) {
    console.error(
      `\n[static-guards] FAILED — ${failures.length} check(s):\n`
    );
    failures.forEach((f, i) => {
      console.error(`  ${i + 1}. ${f.name}`);
    });
    const fixableFailed = failures.some((f) =>
      [...FIXABLE].some((path) => getName(path) === f.name)
    );
    if (fixableFailed && !FIX) {
      console.error(
        `\n[static-guards] Some failures are auto-fixable. Try: npm run static-guards -- --fix`
      );
    }
    process.exit(1);
  }

  process.exit(0);
}

main();
