// test/parsers/frontmatter-utils.test.ts
//
// Unit tests for the shared frontmatter helpers. Currently covers
// `splitPrerequisites` — the rest of frontmatter-utils (humanizeTag,
// escapeHtml) is exercised transitively via render-frontmatter.test.ts.
import { describe, it, expect } from 'vitest';
import { splitPrerequisites } from '../../scripts/parsers/frontmatter-utils.js';

describe('splitPrerequisites', () => {
  it('returns [] for empty input', () => {
    expect(splitPrerequisites('')).toEqual([]);
    expect(splitPrerequisites(undefined as unknown as string)).toEqual([]);
  });

  it('strips leading "- " and trims whitespace per bullet', () => {
    const input = '- SAP BTP, ABAP Environment\n- SAP S/4HANA, ABAP Environment\n';
    expect(splitPrerequisites(input)).toEqual([
      'SAP BTP, ABAP Environment',
      'SAP S/4HANA, ABAP Environment',
    ]);
  });

  it('escapes HTML metacharacters in bullet text', () => {
    const input = '- Use <kbd>Ctrl+C</kbd> to copy & paste';
    expect(splitPrerequisites(input)).toEqual([
      'Use &lt;kbd&gt;Ctrl+C&lt;/kbd&gt; to copy &amp; paste',
    ]);
  });

  it('drops trailing thematic-break tokens (issue #163)', () => {
    // Realistic shape of what extractSection captures when the source
    // markdown closes the Prerequisites section with a `---` HR before
    // the first step heading. The HR must NOT survive as a bullet.
    const input = [
      '- SAP BTP, ABAP Environment',
      '- SAP S/4HANA, ABAP Environment',
      '- A package located in ZLOCAL',
      '',
      '---',
      '',
    ].join('\n');
    expect(splitPrerequisites(input)).toEqual([
      'SAP BTP, ABAP Environment',
      'SAP S/4HANA, ABAP Environment',
      'A package located in ZLOCAL',
    ]);
  });

  it('drops 4-or-more-dash thematic breaks too', () => {
    const input = '- Real prereq\n----';
    expect(splitPrerequisites(input)).toEqual(['Real prereq']);
  });

  it('keeps prose that merely *contains* dashes', () => {
    // Don't over-filter — only standalone HR lines should be dropped.
    const input = '- Use --force to overwrite\n- A-B-C example';
    expect(splitPrerequisites(input)).toEqual([
      'Use --force to overwrite',
      'A-B-C example',
    ]);
  });
});
