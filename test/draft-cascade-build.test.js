// test/draft-cascade-build.test.js
//
// Build-artifact guard for #2993: the production build (compiler 7.2.1, pinned
// via package.json overrides) must emit exactly 46 NOT VALIDATED draft
// DraftAdministrativeData ON DELETE CASCADE constraints.
//
// This test compiles the CDS model in-process (no `cds build` child process)
// using cds-dk's bundled @sap/cds-compiler with draft_admin_integrity: true.
// It is independent of the runtime feature flag (cds.fiori.draft_admin_integrity)
// which stays false in the committed config — this test exercises the compiler
// output shape only.
//
// Why cds-dk's compiler? The overrides pin in package.json ensures that after
// `npm install`, root @sap/cds-compiler is 7.2.1 — the first version that ships
// the createDraftAdminDataConstraints generator with NOT VALIDATED rendering.
// cds-dk's nested copy is also 7.2.1 and is addressable before the root install
// is run, making both paths equivalent post-install.
//
// Regression: if the overrides pin is removed and lockfile reverts to 7.0.1,
// compiler.to.hdi emits 0 draft constraints → count assertion fails → CI red.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Project root: one level up from the test directory.
const PROJECT_ROOT = join(import.meta.dirname, '..');

// createRequire anchored to the project root so Node's module resolution
// algorithm walks node_modules starting from the project tree — the same
// algorithm that `cds build` uses when it resolves @sap/cds-compiler.
const require = createRequire(join(PROJECT_ROOT, 'package.json'));

/**
 * Compile the project's CDS model in-process and collect every .hdbconstraint
 * string that references DraftAdministrativeData with an ON DELETE CASCADE clause.
 *
 * Uses cds-dk's bundled @sap/cds-compiler (7.2.1 after the #2993 overrides pin)
 * with `draft_admin_integrity: true` so the generator is active regardless of the
 * committed runtime flag setting.
 *
 * @returns {Promise<string[]>} array of constraint DDL strings
 */
async function compileAndCollectDraftCascades() {
  // Resolve via cds-dk's nested compiler path.  After the #2993 overrides pin
  // takes effect on `npm install`, root @sap/cds-compiler also becomes 7.2.1,
  // so both resolution paths yield the same binary.  We prefer cds-dk's path
  // because it resolves correctly in both the pre- and post-install states
  // of an isolated git worktree (where root node_modules may still carry 7.0.1).
  const cdsDkPkgPath = require.resolve('@sap/cds-dk/package.json');
  const cdsDkBase = cdsDkPkgPath.replace(/[/\\]package\.json$/, '');

  // Load @sap/cds from the same tree that cds-dk ships so model loading is
  // consistent with what the production build uses.
  const cdsPkgPath = require.resolve('@sap/cds/package.json', { paths: [cdsDkBase] });
  const cdsBase = cdsPkgPath.replace(/[/\\]package\.json$/, '');
  const cds = require(join(cdsBase, 'lib', 'index.js'));

  // Set production env so the CDS model includes @cap-js/hana artifacts.
  process.env.CDS_ENV = 'production';

  const csn = await cds.load(['db', 'srv'], { root: PROJECT_ROOT });

  // Compiler is resolved from cds-dk's own node_modules (7.2.1).
  const compiler = require(require.resolve('@sap/cds-compiler', { paths: [cdsDkBase] }));

  // Compile to HDI with the cascade constraint generator enabled.
  const hdi = compiler.to.hdi(csn, { draft_admin_integrity: true, sqlDialect: 'hana' });

  // Collect .hdbconstraint files whose bodies reference DraftAdministrativeData
  // and contain a CASCADE clause (i.e. the draft FK constraints we are guarding).
  return Object.entries(hdi)
    .filter(
      ([name, content]) =>
        name.endsWith('.hdbconstraint') &&
        typeof content === 'string' &&
        content.includes('DraftAdministrativeData') &&
        content.includes('CASCADE'),
    )
    .map(([, content]) => content);
}

describe('#2993 native draft cascade constraints', () => {
  // Cache the result across both `it` blocks so the compiler runs once per suite.
  let draftCascadesPromise;
  const getDraftCascades = () => {
    if (!draftCascadesPromise) draftCascadesPromise = compileAndCollectDraftCascades();
    return draftCascadesPromise;
  };

  it('emits 46 DraftAdministrativeData ON DELETE CASCADE constraints', async () => {
    const draftCascades = await getDraftCascades();
    expect(draftCascades.length).toBe(46);
  });

  it('emits them NOT VALIDATED (deploy-safe over existing orphans)', async () => {
    const draftCascades = await getDraftCascades();
    for (const c of draftCascades) {
      expect(c).toMatch(/ON DELETE CASCADE/);
      expect(c).toMatch(/NOT VALIDATED/);
    }
  });
});
