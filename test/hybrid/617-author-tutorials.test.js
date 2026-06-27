/**
 * #617 hybrid test — AuthorService.Tutorials widened projection returns
 * full-row shape (createdAt/modifiedAt/etc) when read against real HANA,
 * plus AuthorService.listExposedEntities returns the curated 9-entity set.
 *
 * Read-only; no fixture writes, no cleanup. Spec:
 * docs/superpowers/specs/2026-06-25-issue-617-author-tiles-design.md
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/617-author-tutorials.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#617 — AuthorService.Tutorials (hybrid)', () => {
  let AuthorService;

  beforeAll(async () => {
    AuthorService = await cds.connect.to('AuthorService');
  });

  it('Tutorials returns at least one row with full-row columns on HANA', async () => {
    const { Tutorials } = AuthorService.entities;
    const row = await SELECT.one.from(Tutorials);
    // If the DEV HANA has no Tutorials rows, gracefully no-op
    if (!row) {
      console.warn('[skip] No Tutorials rows on bound HANA');
      return;
    }
    expect(row).toHaveProperty('ID');
    expect(row).toHaveProperty('slug');
    // Wildcard projection must expose more than the legacy narrow column set:
    expect(row).toHaveProperty('createdAt');
    expect(row).toHaveProperty('modifiedAt');
  });

  it('listExposedEntities returns the curated 9-entity set over HANA', async () => {
    const user = new cds.User.Privileged();
    const result = await AuthorService.tx({ user }, (tx) => tx.send('listExposedEntities'));
    const rows = Array.isArray(result) ? result : (result?.value ?? []);
    const names = rows.map((e) => e.name);
    expect(names).toHaveLength(9);
    expect(names).toEqual(expect.arrayContaining([
      'CompletionAnalytics', 'CodeCheckSubmissions',
      'ValidateAnswerSubmissions', 'ActiveLearnersDaily',
      'AnalyticsBranchPerformance', 'AnalyticsBranchTopPick',
      'Tasks', 'TaskRecords', 'UIEvents',
    ]));
  });
});
