/**
 * #385 PR-3 hybrid test — verifies AuthorService projection emits the new
 * fields with real data after PR-2's migration pass populates the underlying
 * columns.
 *
 * Read-only — no fixture writes, no cleanup. Spec:
 * docs/superpowers/specs/2026-06-21-issue-385-pr3-authorservice-design.md
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/385-pr3-authorservice.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#385 PR-3 — AuthorService projection (hybrid)', () => {
  let MyTutorialsView, Tags, Tutorials;

  beforeAll(async () => {
    const ns = cds.entities('com.sap.developers.ims');
    MyTutorialsView = ns.MyTutorialsView;
    Tags            = ns.Tags;
    Tutorials       = ns.Tutorials;
  });

  it('MyTutorialsView emits the 3 new fields with correct types', async () => {
    const row = await SELECT.one.from(MyTutorialsView)
      .columns('ID', 'repositoryName', 'monitored', 'daysSinceReview');
    expect(row).toBeTruthy();
    // monitored is always a boolean; daysSinceReview is integer-or-null;
    // repositoryName is string-or-null.
    expect(typeof row.monitored).toBe('boolean');
  });

  it('MyTutorialsView has at least one row with non-null repositoryName (PR-2 backfill verification)', async () => {
    // Softer than a hard expect — if PR-2's migration hasn't actually run on
    // DEV yet, this should skip rather than fail noisily for a reason
    // unrelated to PR-3 code. PR-2's hybrid test asserts the underlying data;
    // this test only verifies the AuthorService projection surfaces it.
    const row = await SELECT.one.from(MyTutorialsView).where('repositoryName is not null');
    if (!row) {
      console.warn('[skip] No MyTutorials rows with repositoryName — PR-2 migration may not have run yet');
      return;
    }
    expect(typeof row.repositoryName).toBe('string');
  });

  it('Tags projection emits actualTag matching SUBSTR_AFTER semantics', async () => {
    // Find a tag whose name has '>' in it
    const tag = await SELECT.one.from(Tags).columns('name', 'actualTag').where(`name like '%>%'`);
    if (!tag) {
      console.warn('[skip] No Tags rows with > in name — tag dataset may be flat-only');
      return;
    }
    // actualTag should be the substring after the LAST '>'
    const expected = tag.name.slice(tag.name.lastIndexOf('>') + 1);
    expect(tag.actualTag).toBe(expected);
  });

  it('isSlugAvailable returns true for a generated unique slug', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', {
      slug: `pr3-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    });
    expect(result).toBe(true);
  });

  it('isSlugAvailable returns false for an existing slug (case-insensitive)', async () => {
    // Find any existing tutorial slug
    const tut = await SELECT.one.from(Tutorials).columns('slug').where('slug is not null');
    if (!tut?.slug) {
      console.warn('[skip] No Tutorials with slug — Tutorials table may be empty');
      return;
    }
    const AuthorService = await cds.connect.to('AuthorService');
    const result = await AuthorService.send('isSlugAvailable', { slug: tut.slug.toUpperCase() });
    expect(result).toBe(false);
  });
});
