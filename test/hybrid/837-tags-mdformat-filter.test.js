/**
 * #837 hybrid test — AuthorService.Tags $filter over the virtual `mdFormat`
 * field must not crash. The issue's motivating URL is:
 *
 *   /author/Tags?$filter=contains(tolower(name),tolower('Business'))
 *                        or contains(tolower(mdFormat),tolower('Business'))
 *                        &$top=10&$skip=0&$count=true
 *
 * Before the fix in srv/lib/tag-md-format-handlers.js, this raised a HANA
 * SQL error (no column `mdFormat`) surfaced as HTTP 500. After the fix:
 *
 *   * before('READ') rewrites the mdFormat leaf to `titlePath` for
 *     SQL push-down (strict superset for plain-word searches).
 *   * after('READ') populates the virtual via applyMdFormat, then
 *     re-applies the ORIGINAL filter in JS to drop false positives.
 *
 * Read-only — no fixture writes, no cleanup.
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/837-tags-mdformat-filter.test.js
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#837 — AuthorService.Tags $filter on virtual mdFormat (hybrid)', () => {
  it('does not 500 when $filter references only mdFormat', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    // contains(tolower(mdFormat), 'business') — the pure-mdFormat variant.
    // CAP's cds.ql builder doesn't have a first-class contains helper on
    // virtuals, so express as a filter string. `.limit(10, 0)` mimics
    // Sage's `$top=10&$skip=0`.
    const rows = await AuthorService.tx(
      { user: { id: 'hybrid-probe', roles: { 'Tutorial.Author': true } } },
      (tx) =>
        tx.run(
          SELECT.from(AuthorService.entities.Tags)
            .columns('ID', 'name', 'titlePath', 'mdFormat')
            .where(`lower(mdFormat) like '%business%'`)
            .limit(10, 0)
        )
    );
    expect(Array.isArray(rows)).toBe(true);
    // If any rows come back, they MUST have mdFormat populated and
    // MUST actually contain 'business' in their mdFormat.
    for (const row of rows) {
      expect(typeof row.mdFormat).toBe('string');
      expect(row.mdFormat.toLowerCase()).toContain('business');
    }
  });

  it('honors the OR pattern (name OR mdFormat) from the #837 report', async () => {
    const AuthorService = await cds.connect.to('AuthorService');
    // The exact shape from Riley's Sage extension: OR between name and
    // mdFormat. Superset-then-JS-filter must produce a coherent result.
    const rows = await AuthorService.tx(
      { user: { id: 'hybrid-probe', roles: { 'Tutorial.Author': true } } },
      (tx) =>
        tx.run(
          SELECT.from(AuthorService.entities.Tags)
            .columns('ID', 'name', 'titlePath', 'mdFormat')
            .where(
              `lower(name) like '%business%' or lower(mdFormat) like '%business%'`
            )
            .limit(10, 0)
        )
    );
    expect(Array.isArray(rows)).toBe(true);
    // Each returned row must satisfy at least one arm of the OR (otherwise
    // the JS post-filter is broken).
    for (const row of rows) {
      const inName = (row.name || '').toLowerCase().includes('business');
      const inMd = (row.mdFormat || '').toLowerCase().includes('business');
      expect(inName || inMd).toBe(true);
    }
  });
});
