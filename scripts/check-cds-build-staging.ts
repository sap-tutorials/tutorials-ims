#!/usr/bin/env tsx
/**
 * scripts/check-cds-build-staging.ts
 *
 * Verifies that `cds build --production` produces no diff in tracked files
 * under db/last-dev/ and db/src/*.hdbmigrationtable. If it DOES produce a
 * diff, the PR author forgot to stage the regenerated artifacts that
 * accompany a schema change.
 *
 * This bites us every time someone changes db/schema.cds without running
 * `cds build` locally first (PR #518 → #521 follow-up on 2026-06-21).
 * The artifacts ARE deterministic outputs — different developers running
 * `cds build` produce byte-identical files — so a CI check is the
 * authoritative way to enforce "if you touched schema.cds, you also need
 * to stage the build output".
 *
 * Exit codes:
 *   0  no diff after `cds build` — staged artifacts match the current schema
 *   1  diff detected; PR author must run `cds build --production` and commit
 *   2  fatal error (cds build itself failed, etc.)
 *
 * The check is opt-in via path filter (only fires when a PR touches CDS
 * sources). Doesn't catch "schema didn't change but artifacts did" — that's
 * not a real failure mode here.
 *
 * Runs in CI via .github/workflows/cds-build-staging-check.yml.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RELEVANT_PATHS = [
  'db/last-dev/',
  'db/src/',  // hdbmigrationtable, hdbsequence, etc. — every generated artifact
];

function run(cmd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', status: 0 };
  } catch (e: any) {
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? e.message ?? '').toString(),
      status: e.status ?? 1,
    };
  }
}

function gitDiffNames(paths: string[]): string[] {
  const r = run('git', ['diff', '--name-only', '--', ...paths]);
  if (r.status !== 0) {
    process.stderr.write(`git diff failed (status ${r.status}):\n${r.stderr}\n`);
    process.exit(2);
  }
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function main(): void {
  process.stdout.write('Running `cds build --production` to regenerate CDS artifacts...\n');

  // Resolve the cds-dk entry point directly so we don't depend on `npx`
  // being on PATH (it isn't always on Windows shell environments). The
  // file is checked into the repo by @sap/cds-dk in devDependencies.
  const cdsBin = resolve(process.cwd(), 'node_modules', '@sap', 'cds-dk', 'bin', 'cds.js');
  if (!existsSync(cdsBin)) {
    process.stderr.write(`FATAL: cds-dk binary not found at ${cdsBin}.\n`);
    process.stderr.write('Run `npm ci` first.\n');
    process.exit(2);
  }
  const buildR = run(process.execPath, [cdsBin, 'build', '--production']);
  if (buildR.status !== 0) {
    process.stderr.write('FATAL: `cds build --production` failed:\n');
    process.stderr.write(buildR.stdout + '\n');
    process.stderr.write(buildR.stderr + '\n');
    process.exit(2);
  }
  // Suppress the build's verbose stdout from CI logs — only surface if it failed.

  const dirtyFiles = gitDiffNames(RELEVANT_PATHS);

  if (dirtyFiles.length === 0) {
    process.stdout.write('[cds-build-staging] OK — `cds build` produces no diff. Staged artifacts match the current schema.\n');
    return;
  }

  process.stderr.write('\n[cds-build-staging] FAILED — `cds build --production` produced diffs in tracked artifacts:\n');
  process.stderr.write('\n');
  for (const f of dirtyFiles) {
    process.stderr.write(`  - ${f}\n`);
  }
  process.stderr.write('\n');
  process.stderr.write('  Cause: the PR changes a CDS source (db/schema.cds or similar) but the\n');
  process.stderr.write('         generated artifacts that record the schema state (csn.json snapshot,\n');
  process.stderr.write('         hdbmigrationtable bumps) were not regenerated and staged with the PR.\n');
  process.stderr.write('\n');
  process.stderr.write('  Fix locally:\n');
  process.stderr.write('         npx cds build --production\n');
  process.stderr.write(`         git add ${RELEVANT_PATHS.join(' ')}\n`);
  process.stderr.write('         git commit --amend --no-edit  # (or a follow-up commit)\n');
  process.stderr.write('         git push --force-with-lease    # if amending\n');
  process.stderr.write('\n');
  process.stderr.write('  Symptom if shipped without fix: `mbt build` regenerates the artifacts at\n');
  process.stderr.write('  deploy time so the deployed schema is correct, BUT every developer\n');
  process.stderr.write('  pulling main sees a perpetually dirty working tree after `mbt build`\n');
  process.stderr.write('  (caught Tom 2026-06-21; needed PR #521 to capture missing PR #518 artifacts).\n');
  process.stderr.write('\n');
  process.stderr.write('  Detailed diff:\n');
  for (const f of dirtyFiles) {
    const r = run('git', ['diff', '--', f]);
    process.stderr.write(`\n=== ${f} ===\n${r.stdout}\n`);
  }
  process.exit(1);
}

main();
