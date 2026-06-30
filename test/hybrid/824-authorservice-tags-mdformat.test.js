/**
 * #824 hybrid test — verifies AuthorService.Tags populates the virtual
 * `mdFormat` field via the after('READ', 'Tags') handler.
 *
 * Read-only — no fixture writes, no cleanup.
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/824-authorservice-tags-mdformat.test.js
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#824 — AuthorService.Tags.mdFormat (hybrid)', () => {
  it('populates mdFormat from titlePath on read (parity with AdminService)', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    // Pick a representative row: "Topic : SAP Community" is the case from the
    // issue. If it isn't present in this environment, fall back to ANY row with
    // a non-null titlePath and assert the shape generically.
    const rows = await AuthorService.tx(
      { user: { id: 'hybrid-probe', roles: { 'Tutorial.Author': true } } },
      (tx) =>
        tx.run(
          SELECT.from(AuthorService.entities.Tags)
            .columns('ID', 'name', 'titlePath', 'mdFormat')
            .where(`titlePath is not null`)
            .limit(20)
        )
    );
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length === 0) {
      console.warn('[skip] No Tags rows with non-null titlePath — table may be empty in this env');
      return;
    }
    for (const row of rows) {
      expect(typeof row.mdFormat).toBe('string');
      expect(row.mdFormat.length).toBeGreaterThan(0);
      // Shape: either "x" (single segment) or "x>y" (multi-segment). Lowercase,
      // no separators other than '-' and '>'.
      expect(row.mdFormat).toMatch(/^[a-z\d-]+(>[a-z\d-]+)?$/);
    }

    // Targeted assertion for the issue's motivating row, when present.
    const community = rows.find((r) => r.titlePath === 'Topic : SAP Community');
    if (community) {
      expect(community.mdFormat).toBe('topic>sap-community');
    }
  });
});
