// Regression tests for AEM-legacy "blockquoted code fence" normalization.
//
// Legacy SAP tutorials wrap code inside a blockquote note using the pattern:
//
//   >```Shell
//   >some command
//   >```
//
// where EVERY line — including the code content — carries the `>` blockquote
// marker. AEM's lenient renderer also accepted a MALFORMED variant where the
// fence delimiters are blockquoted but the code content lines are NOT:
//
//   >```Shell
//   some command       <-- missing `>`
//   >```
//
// Under CommonMark/Goldmark (Hugo) that un-prefixed line terminates the
// blockquote, so the opening/closing fences render as empty code blocks and
// the "code" lands OUTSIDE the code window as a plain paragraph. First
// surfaced on hana-clients-install step 2 ("pico ~/.bash_profile" rendered
// outside the code window); 17 tutorials / 32 occurrences share the pattern.
//
// normalizeBlockquotedFences() heals the malformed variant by re-attaching the
// `>` marker to orphaned content lines, matching the well-formed convention.

import { describe, it, expect } from 'vitest'
import { normalizeBlockquotedFences } from '../blockquote-fence.js'

describe('normalizeBlockquotedFences', () => {
  it('prefixes an orphaned code line inside a blockquoted fence', () => {
    const input = [
      '>```Shell',
      'pico ~/.bash_profile',
      '>```',
    ].join('\n')
    const expected = [
      '>```Shell',
      '>pico ~/.bash_profile',
      '>```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('preserves list-item indentation on the blockquote marker', () => {
    // hana-clients-install shape: 4-space list-continuation indent + `>`.
    const input = [
      '    >```Shell (Linux or Mac)',
      '    pico ~/.bash_profile',
      '    >```',
    ].join('\n')
    const expected = [
      '    >```Shell (Linux or Mac)',
      '    >pico ~/.bash_profile',
      '    >```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('preserves relative code indentation (does not flatten nested lines)', () => {
    // A JSON body inside a `> ` blockquoted fence must keep its inner 2-space
    // indent after the marker is re-attached.
    const input = [
      '> ```json',
      '{',
      '  "key": "value"',
      '}',
      '> ```',
    ].join('\n')
    const expected = [
      '> ```json',
      '> {',
      '>   "key": "value"',
      '> }',
      '> ```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('leaves a well-formed blockquoted fence unchanged', () => {
    const input = [
      '>```Shell/Bash',
      '>npx fiori add deploy-config',
      '>```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(input)
  })

  it('leaves a plain (non-blockquoted) fenced code block unchanged', () => {
    const input = [
      '```Shell',
      'hdbsql -v',
      '```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(input)
  })

  it('does not touch blockquote prose that contains no fence', () => {
    const input = [
      '>To configure your path on Linux:',
      '',
      'This is a normal paragraph.',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(input)
  })

  it('re-attaches the marker to a blank line inside the fenced code', () => {
    // A bare blank line inside the code would otherwise terminate the
    // blockquote and split the code block in two.
    const input = [
      '>```Shell',
      'line one',
      '',
      'line two',
      '>```',
    ].join('\n')
    const expected = [
      '>```Shell',
      '>line one',
      '>',
      '>line two',
      '>```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('handles multiple malformed blocks in one document', () => {
    const input = [
      '>```Shell',
      'export PATH=$PATH:/home/dan/sap/hdbclient',
      '>```',
      '',
      'Some prose.',
      '',
      '>```Shell',
      'source ~/.bash_profile',
      '>```',
    ].join('\n')
    const expected = [
      '>```Shell',
      '>export PATH=$PATH:/home/dan/sap/hdbclient',
      '>```',
      '',
      'Some prose.',
      '',
      '>```Shell',
      '>source ~/.bash_profile',
      '>```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('does not alter content when the blockquoted fence never closes', () => {
    // Defensive: an unterminated blockquoted fence should be left verbatim
    // rather than greedily prefixing the rest of the document.
    const input = [
      '>```Shell',
      'pico ~/.bash_profile',
      '',
      '## A later heading that is clearly not code',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(input)
  })

  it('heals a blockquoted OPEN fence closed by a PLAIN fence (mixed variant)', () => {
    // btp-cf-deploy-mta shape: `>```lang` opens inside a blockquote but the
    // closing fence has no `>`. Both the content AND the close must become
    // blockquoted so Goldmark keeps the code inside the note.
    const input = [
      '>``` Console command',
      'cf deploy <PATH_TO_MTAR>',
      '```',
    ].join('\n')
    const expected = [
      '>``` Console command',
      '>cf deploy <PATH_TO_MTAR>',
      '>```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('heals a mixed-variant JSON block preserving nested indentation', () => {
    // private-link-aws shape: `> ```JSON` open, plain close, deeply-indented
    // JSON body. Marker re-attached with the author's `> ` style; inner indent
    // preserved.
    const input = [
      '> ```JSON',
      '{',
      '    "privatelink": [',
      '        { "guid": "x" }',
      '    ]',
      '}',
      '```',
    ].join('\n')
    const expected = [
      '> ```JSON',
      '> {',
      '>     "privatelink": [',
      '>         { "guid": "x" }',
      '>     ]',
      '> }',
      '> ```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(expected)
  })

  it('does not pair a blockquoted open with a distant plain close across a blank line', () => {
    // Safety: a blank line between the (unclosed) blockquoted open and a plain
    // fence means the plain fence likely belongs to a separate block. Leave
    // verbatim rather than swallowing the gap.
    const input = [
      '>```Shell',
      'some note',
      '',
      'unrelated prose',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n')
    expect(normalizeBlockquotedFences(input)).toBe(input)
  })
})

