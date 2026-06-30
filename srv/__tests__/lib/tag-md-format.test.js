// srv/__tests__/lib/tag-md-format.test.js
//
// Regression guard for #824 — algorithm parity with the legacy Java IMS
// `com.sap.developers.ims.util.TagUtil#textToMdFormat`. The four parity
// cases below MATCH the JUnit cases at
// D:/projects/com.sap.developers.ims/application/src/test/java/.../TagUtilTest.java
// — keep them aligned if either side changes.
//
// Also smoke-tests applyMdFormat() as the body of an after('READ', 'Tags')
// handler so AdminService and AuthorService stay symmetric.

import { describe, it, expect } from 'vitest';
import { titlePathToMdFormat, applyMdFormat } from '../../lib/tag-md-format.js';

describe('titlePathToMdFormat — Java IMS parity', () => {
  // Java case: shouldReturnMdFormatNull
  it('returns empty string for null', () => {
    expect(titlePathToMdFormat(null)).toBe('');
  });

  // Java case: shouldReturnMdFormatNull (also covers undefined / "")
  it('returns empty string for undefined and ""', () => {
    expect(titlePathToMdFormat(undefined)).toBe('');
    expect(titlePathToMdFormat('')).toBe('');
  });

  // Java case: shouldReturnMdFormatOneWord — input "Path" → "path"
  it('lowercases a single-segment path', () => {
    expect(titlePathToMdFormat('Path')).toBe('path');
  });

  // Java case: shouldReturnMdFormatTwoWords — "Path : Second path" → "path>second-path"
  it('uses first + last segments joined by ">", spaces become "-"', () => {
    expect(titlePathToMdFormat('Path : Second path')).toBe('path>second-path');
  });

  // Java case: shouldReturnMdFormatThreeWords — leading "/" and parens collapse to "-"
  it('replaces non-alphanumeric runs verbatim — char-for-char, not collapsed', () => {
    expect(titlePathToMdFormat('Path : Second path / Third Long (Path)'))
      .toBe('path>third-long--path-');
  });

  // The motivating row for #824 — real production tag.
  it('matches the Topic : SAP Community production case from the issue', () => {
    expect(titlePathToMdFormat('Topic : SAP Community')).toBe('topic>sap-community');
  });

  // Real production rows from HANA (sampled 2026-06-30) — sanity smoke.
  it('handles deeply nested Software Product paths', () => {
    expect(titlePathToMdFormat('Software Product : Technology Platform / SAP HANA'))
      .toBe('software-product>sap-hana');
    expect(titlePathToMdFormat('Software Product : Technology Platform / SAP Business Technology Platform / API Management'))
      .toBe('software-product>api-management');
  });
});

describe('applyMdFormat — handler body', () => {
  it('mutates an array of rows in-place', () => {
    const rows = [
      { titlePath: 'Topic : SAP Community' },
      { titlePath: 'Path' },
      { titlePath: null },
    ];
    applyMdFormat(rows);
    expect(rows[0].mdFormat).toBe('topic>sap-community');
    expect(rows[1].mdFormat).toBe('path');
    expect(rows[2].mdFormat).toBe('');
  });

  it('mutates a single row when passed an object (CAP one-result shape)', () => {
    const row = { titlePath: 'Software Product : Technology Platform / SAP HANA' };
    applyMdFormat(row);
    expect(row.mdFormat).toBe('software-product>sap-hana');
  });

  it('tolerates null/undefined cells in the row array', () => {
    const rows = [null, undefined, { titlePath: 'Path' }];
    expect(() => applyMdFormat(rows)).not.toThrow();
    expect(rows[2].mdFormat).toBe('path');
  });
});
