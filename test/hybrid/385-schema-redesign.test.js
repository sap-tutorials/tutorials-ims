// test/hybrid/385-schema-redesign.test.js
// PR-1 of #385. Verifies the new TutorialRepositories shape + 2-level
// Association chain query work against live HANA (not just SQLite).
//
// Run with: npm run test:hybrid (requires cds bind to tutorials-hana)
// Guards via test/hybrid/_guard.js — needs ALLOW_HYBRID_WRITES=true.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe.runIf(isSafeForWrites())('#385 PR-1 schema redesign (hybrid)', () => {
  let TutorialRepositories, TutorialMeta, TutorialContributors, Tutorials, Tags;
  const PREFIX = '__TEST_385__';
  const ids = {
    tutorial: '385a-1111-0000-0000-000000000001',
    meta:     '385a-2222-0000-0000-000000000001',
    repo:     '385a-3333-0000-0000-000000000001',
    contrib:  '385a-4444-0000-0000-000000000001',
    tag:      '385a-5555-0000-0000-000000000001',
  };

  beforeAll(async () => {
    ({ TutorialRepositories, TutorialMeta, TutorialContributors, Tutorials, Tags } =
      cds.entities('com.sap.developers.ims'));
  });

  afterAll(async () => {
    // Cleanup all __TEST_385__ rows. Order: drop FK-dependents before FK-targets.
    await DELETE.from(TutorialMeta).where({ ID: { in: [ids.meta] } });
    await DELETE.from(TutorialRepositories).where({ ID: { in: [ids.repo] } });
    await DELETE.from(TutorialContributors).where({ ID: { in: [ids.contrib] } });
    await DELETE.from(Tutorials).where({ ID: { in: [ids.tutorial] } });
    await DELETE.from(Tags).where({ ID: { in: [ids.tag] } });
    // Also cleanup any stray dup-name test repos
    await DELETE.from(TutorialRepositories).where({ ID: 'duplicate-test-id-385a' });
  });

  it('TutorialRepositories.name has a unique constraint', async () => {
    const repo1 = { ID: ids.repo, name: `${PREFIX}-btp-foundation` };
    const repo2 = { ID: 'duplicate-test-id-385a', name: `${PREFIX}-btp-foundation` };

    await INSERT.into(TutorialRepositories).entries(repo1);
    // Second insert with the same name should fail @assert.unique.name.
    await expect(INSERT.into(TutorialRepositories).entries(repo2)).rejects.toThrow();
  });

  it('Tags accepts the 3 new columns (semaphoreId/isActualTag/isInterestItem)', async () => {
    await INSERT.into(Tags).entries({
      ID: ids.tag, name: `${PREFIX}-tag`,
      semaphoreId: 'test-semaphore', isActualTag: true, isInterestItem: false,
      legacyId: 938501,
    });
    const row = await SELECT.one.from(Tags).where({ ID: ids.tag });
    expect(row.semaphoreId).toBe('test-semaphore');
    expect(row.isActualTag).toBe(true);
    expect(row.isInterestItem).toBe(false);
  });

  it('2-level chain query resolves repo-group owner email end-to-end', async () => {
    // FK chain: TutorialContributor.ID → TutorialRepositories.repositoryOwner_ID → ...
    //           TutorialRepositories.ID ← TutorialMeta.repository_ID
    await INSERT.into(Tutorials).entries({
      ID: ids.tutorial, slug: `${PREFIX}-chain-tutorial`,
      title: 'PR-1 hybrid chain test', legacyId: 938301, status: 'ACTIVE',
    });
    await INSERT.into(TutorialContributors).entries({
      ID: ids.contrib, tutorial_ID: ids.tutorial,
      name: 'Repo Owner Hybrid', email: 'repoowner-hybrid@sap.com',
      role: 'OWNER', legacyId: 938401,
    });
    // The TutorialRepositories.ID was already inserted in the first test
    // (the unique-constraint test); update it to add the repositoryOwner.
    await UPDATE(TutorialRepositories).set({ repositoryOwner_ID: ids.contrib, legacyId: 938601 }).where({ ID: ids.repo });
    await INSERT.into(TutorialMeta).entries({
      ID: ids.meta, tutorial_ID: ids.tutorial,
      reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
      owner: 'metaowner-hybrid@sap.com', monitoredStatus: 'ACTIVE',
      notificationNumber: 0, legacyId: 938201,
      repository_ID: ids.repo,
    });

    const result = await SELECT.one.from(TutorialMeta)
      .columns('repository.repositoryOwner.email as email')
      .where({ ID: ids.meta });

    expect(result).toBeTruthy();
    expect(result.email).toBe('repoowner-hybrid@sap.com');
  });

  it('2-level chain query returns email=null when meta.repository is unset (NULL-safe)', async () => {
    // Re-use the existing TutorialMeta row from the previous test. Update it
    // to clear repository_ID, then re-run the chain query.
    await UPDATE(TutorialMeta).set({ repository_ID: null }).where({ ID: ids.meta });

    const result = await SELECT.one.from(TutorialMeta)
      .columns('repository.repositoryOwner.email as email')
      .where({ ID: ids.meta });

    expect(result).toBeTruthy();
    expect(result.email).toBeNull();
  });

  it('TutorialMeta.repository association resolves on a CDS query', async () => {
    // Restore the FK from the previous test's UPDATE.
    await UPDATE(TutorialMeta).set({ repository_ID: ids.repo }).where({ ID: ids.meta });

    const meta = await SELECT.one.from(TutorialMeta)
      .columns('ID', 'repository_ID')
      .where({ ID: ids.meta });
    expect(meta.repository_ID).toBe(ids.repo);

    const repo = await SELECT.one.from(TutorialRepositories).where({ ID: meta.repository_ID });
    expect(repo.name).toBe(`${PREFIX}-btp-foundation`);
  });
});
