/**
 * Unit tests for the slug-aware partition helper exported by
 * scripts/migrate-from-hana.js. The full migrator depends on @sap/hana-client
 * and live HANA credentials, but the partition logic is a pure function we
 * can exercise directly.
 *
 * Issue #338 — guards against the 2026-06-16 cutover-rehearsal regression
 * where a re-run of the migrator created 123 duplicate Groups (and would have
 * duplicated Tutorials too) by plain-INSERTing rows whose SLUG already lived
 * in the target. The patch mirrors the publish-side LOWER(slug)=? upsert in
 * srv/lib/content-publish-session.js.
 */
import { describe, it, expect } from 'vitest';
import { partitionBySlug } from '../../scripts/migrate-from-hana.js';

describe('partitionBySlug()', () => {
  it('partitions rows into inserts (new slugs) and updates (matching slugs)', () => {
    const mapped = [
      { ID: 'new-id-1', SLUG: 'fresh-tutorial', TITLE: 'Fresh' },
      { ID: 'new-id-2', SLUG: 'foo', TITLE: 'New Title' },
    ];
    const existingMap = new Map([['foo', 'existing-id-foo']]);

    const { inserts, updates, passthrough } = partitionBySlug(mapped, existingMap);

    expect(inserts).toHaveLength(1);
    expect(inserts[0].SLUG).toBe('fresh-tutorial');

    expect(updates).toHaveLength(1);
    // The update row's ID must be rewritten to the existing target row's ID
    // so the UPDATE … WHERE "ID" = ? hits the right record. Without this
    // rewrite the UPDATE would silently match zero rows.
    expect(updates[0].ID).toBe('existing-id-foo');
    expect(updates[0].SLUG).toBe('foo');
    expect(updates[0].TITLE).toBe('New Title');

    expect(passthrough).toHaveLength(0);
  });

  it('matches case-insensitively (mixed-case incoming slug vs lowercase existing)', () => {
    const mapped = [
      { ID: 'new-id', SLUG: 'Foo', TITLE: 'New Title' },
    ];
    // existingMap is keyed by the lowercased slug — the lookup logic in
    // migrateEntity calls LOWER(SLUG) on both sides. partitionBySlug
    // lowercases the incoming SLUG before looking it up.
    const existingMap = new Map([['foo', 'existing-id-foo']]);

    const { inserts, updates } = partitionBySlug(mapped, existingMap);

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].ID).toBe('existing-id-foo');
  });

  it('routes rows without a SLUG field to passthrough (no crash)', () => {
    const mapped = [
      { ID: 'a', LEGACYID: 1, TITLE: 'No slug here' },
      { ID: 'b', SLUG: null, TITLE: 'Null slug' },
      { ID: 'c', SLUG: '', TITLE: 'Empty slug' },
      { ID: 'd', SLUG: 'has-slug', TITLE: 'With slug' },
    ];
    const existingMap = new Map();

    const { inserts, updates, passthrough } = partitionBySlug(mapped, existingMap);

    expect(passthrough).toHaveLength(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].SLUG).toBe('has-slug');
    expect(updates).toHaveLength(0);
  });

  it('handles empty input', () => {
    const { inserts, updates, passthrough } = partitionBySlug([], new Map());
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(passthrough).toHaveLength(0);
  });

  it('preserves the existing target row ID and overwrites everything else', () => {
    // Simulates the cutover-rehearsal scenario: a Tutorials row already exists
    // in target with slug='foo' and ID='existing-uuid'. The migrator runs
    // again and produces a payload row with slug='Foo' (mixed case) and the
    // deterministic UUID 'derived-uuid' for that source legacyId. The upsert
    // must:
    //   1. find the existing row by LOWER(slug)
    //   2. preserve its ID (so any FKs already pointing to it survive)
    //   3. carry the new title forward
    const mapped = [
      { ID: 'derived-uuid', LEGACYID: 42, SLUG: 'Foo', TITLE: 'New Title', STATUS: 'ACTIVE' },
    ];
    const existingMap = new Map([['foo', 'existing-uuid']]);

    const { updates } = partitionBySlug(mapped, existingMap);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      ID: 'existing-uuid',     // identity preserved
      SLUG: 'Foo',             // unchanged from input (UPDATE will skip the SLUG column anyway)
      TITLE: 'New Title',      // new value applied
      STATUS: 'ACTIVE',
      LEGACYID: 42,
    });
  });
});
