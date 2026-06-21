/**
 * #385 PR-2 hybrid test — verifies post-deploy data shape after the next
 * migration pass populates TutorialContributors + TutorialRepositories +
 * Tags.semaphoreId + TutorialMeta.repository_ID from IMS source.
 *
 * Read-only — no fixture writes, no cleanup. Spec:
 * docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/385-pr2-migrator.test.js
 * Cannot pass until migrator + backfill have executed against DEV.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#385 PR-2 — post-migration data shape', () => {
  let TutorialContributors, TutorialRepositories, TutorialMeta, Tags;

  beforeAll(async () => {
    ({ TutorialContributors, TutorialRepositories, TutorialMeta, Tags } =
      cds.entities('com.sap.developers.ims'));
  });

  it('TutorialContributors has at least 1 row with a non-empty email', async () => {
    const row = await SELECT.one.from(TutorialContributors).where(`email is not null and email <> ''`);
    expect(row).toBeTruthy();
    expect(row.email).toMatch(/@/);
  });

  it('TutorialRepositories has at least 1 row with a non-empty name', async () => {
    const row = await SELECT.one.from(TutorialRepositories).where(`name is not null and name <> ''`);
    expect(row).toBeTruthy();
    expect(typeof row.name).toBe('string');
    expect(row.name.length).toBeGreaterThan(0);
  });

  it('At least 1 TutorialMeta row has a non-null repository_ID FK', async () => {
    const row = await SELECT.one.from(TutorialMeta).where(`repository_ID is not null`);
    expect(row).toBeTruthy();
  });

  it('End-to-end chain query (PR-1 pattern) returns a non-null email', async () => {
    // PR-1 documented that some repository_owner_id FKs may be null in source.
    // Filter to a TutorialMeta row whose entire chain resolves AND assert the
    // email is non-null — guards against the failure mode where the chain
    // syntactically returns a row but the JOIN produces { email: null }.
    const rows = await SELECT.from(TutorialMeta)
      .columns('repository.repositoryOwner.email as email')
      .where('repository_ID IS NOT NULL');
    const withEmail = rows.find(r => r && r.email);
    expect(withEmail).toBeTruthy();
    expect(withEmail.email).toMatch(/@/);
  });

  it('At least 1 Tags row has a non-null semaphoreId', async () => {
    const row = await SELECT.one.from(Tags).where(`semaphoreId is not null`);
    expect(row).toBeTruthy();
    expect(typeof row.semaphoreId).toBe('string');
  });
});
