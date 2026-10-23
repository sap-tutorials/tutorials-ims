import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unit test for the #2886 dirty-build-inputs deploy gate in
// scripts/deploy-mta.cjs. The 2026-10-21 PROD-down incident shipped an
// approuter built from an UNCOMMITTED working-tree edit to
// hugo/assets/css/sap-fundamental.css, so Hugo fingerprinted the dirty CSS and
// the approuter served a hash the committed-source content pipeline never
// bakes → 404 on every tutorial. Step 0's branch/SHA guard missed it (a dirty
// tree has the same HEAD SHA). `dirtyBuildInputs` parses the output of
//   git status --porcelain -- hugo/assets hugo/layouts
// and returns the TRACKED, modified build-input paths that must block the
// deploy. We test the parser in isolation — the git scoping (the `--` pathspec)
// is exercised by the integration path, not here.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { dirtyBuildInputs } = require(join(__dirname, '..', '..', 'scripts', 'deploy-mta.cjs'));

describe('dirtyBuildInputs (#2886 dirty-tree deploy gate)', () => {
  it('flags a tracked, modified build-input file (the incident case)', () => {
    const porcelain = ' M hugo/assets/css/sap-fundamental.css\n';
    expect(dirtyBuildInputs(porcelain)).toEqual(['hugo/assets/css/sap-fundamental.css']);
  });

  it('flags staged (index-side) modifications too', () => {
    const porcelain = 'M  hugo/assets/css/sap-fundamental.css\n';
    expect(dirtyBuildInputs(porcelain)).toEqual(['hugo/assets/css/sap-fundamental.css']);
  });

  it('flags added, deleted, and renamed tracked inputs', () => {
    const porcelain =
      'A  hugo/layouts/partials/new.html\n' +
      ' D hugo/assets/css/old.css\n' +
      'R  hugo/layouts/a.html -> hugo/layouts/b.html\n';
    const out = dirtyBuildInputs(porcelain);
    expect(out).toContain('hugo/layouts/partials/new.html');
    expect(out).toContain('hugo/assets/css/old.css');
    // A rename reports the destination path (what Hugo would fingerprint).
    expect(out).toContain('hugo/layouts/b.html');
  });

  it('IGNORES untracked files (build:all-generated artifacts, stray scratch)', () => {
    const porcelain =
      '?? hugo/assets/css/scratch.css\n' +
      '?? hugo/layouts/wip.html\n';
    expect(dirtyBuildInputs(porcelain)).toEqual([]);
  });

  it('returns empty on a clean tree', () => {
    expect(dirtyBuildInputs('')).toEqual([]);
    expect(dirtyBuildInputs('\n')).toEqual([]);
  });

  it('handles CRLF and trailing whitespace without phantom entries', () => {
    const porcelain = ' M hugo/assets/css/sap-fundamental.css\r\n';
    expect(dirtyBuildInputs(porcelain)).toEqual(['hugo/assets/css/sap-fundamental.css']);
  });
});
