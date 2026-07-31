// test/parsers/frontmatter-utils.test.ts
//
// Unit tests for the shared frontmatter helpers. Currently covers
// `cleanPrerequisites` — the rest of frontmatter-utils (humanizeTag) is
// exercised transitively via render-frontmatter.test.ts.
import { describe, it, expect } from 'vitest';
import { cleanPrerequisites } from '../../scripts/parsers/frontmatter-utils.js';

describe('cleanPrerequisites', () => {
  it('returns "" for empty input', () => {
    expect(cleanPrerequisites('')).toBe('');
    expect(cleanPrerequisites(undefined as unknown as string)).toBe('');
  });

  it('preserves a contiguous bullet list verbatim (leading "- " kept)', () => {
    // #1388: the markdown structure is now carried through as-is so Hugo's
    // markdownify renders proper <ul><li>. The leading "- " is NOT stripped.
    const input = '- SAP BTP, ABAP Environment\n- SAP S/4HANA, ABAP Environment';
    expect(cleanPrerequisites(input)).toBe(
      '- SAP BTP, ABAP Environment\n- SAP S/4HANA, ABAP Environment',
    );
  });

  it('preserves a prose paragraph as-is (does not coerce to a bullet)', () => {
    // The core #1388 regression: prose used to become a stray bullet.
    const input =
      'You should be comfortable with the SAP Cloud Application Programming\nModel before starting this tutorial.';
    expect(cleanPrerequisites(input)).toBe(
      'You should be comfortable with the SAP Cloud Application Programming\nModel before starting this tutorial.',
    );
  });

  it('preserves mixed prose + bullets structure', () => {
    const input = [
      'Before you begin, make sure you have:',
      '',
      '- An SAP BTP trial account',
      '- Node.js 22 or later installed',
      '',
      'A local Git client is recommended but optional.',
    ].join('\n');
    expect(cleanPrerequisites(input)).toBe(input.trim());
  });

  it('does NOT escape HTML/markdown — markdownify renders it (unsafe=true)', () => {
    const input = '- Use `cds watch` to run & watch';
    expect(cleanPrerequisites(input)).toBe('- Use `cds watch` to run & watch');
  });

  it('drops trailing thematic-break tokens (issue #163)', () => {
    // Realistic shape of what extractSection captures when the source
    // markdown closes the Prerequisites section with a `---` HR before
    // the first step heading. The HR must NOT survive.
    const input = [
      '- SAP BTP, ABAP Environment',
      '- SAP S/4HANA, ABAP Environment',
      '- A package located in ZLOCAL',
      '',
      '---',
      '',
    ].join('\n');
    expect(cleanPrerequisites(input)).toBe(
      [
        '- SAP BTP, ABAP Environment',
        '- SAP S/4HANA, ABAP Environment',
        '- A package located in ZLOCAL',
      ].join('\n'),
    );
  });

  it('drops 4-or-more-dash thematic breaks too', () => {
    expect(cleanPrerequisites('- Real prereq\n----')).toBe('- Real prereq');
  });

  it('keeps prose that merely *contains* dashes', () => {
    // Don't over-filter — only standalone HR lines should be dropped.
    const input = '- Use --force to overwrite\n- A-B-C example';
    expect(cleanPrerequisites(input)).toBe('- Use --force to overwrite\n- A-B-C example');
  });

  it('trims surrounding blank lines', () => {
    expect(cleanPrerequisites('\n\n- Only prereq\n\n')).toBe('- Only prereq');
  });
});
