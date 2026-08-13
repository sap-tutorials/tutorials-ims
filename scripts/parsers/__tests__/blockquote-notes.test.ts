// Regression tests for AEM-legacy "additional details" multi-paragraph note
// normalization (issue #1741).
//
// Legacy SAP tutorials author a single multi-paragraph note using a blockquote
// whose paragraphs are separated by a blockquoted thematic break (`>---`):
//
//   > Access help from the SAP community...
//
//   >---
//
//   > For connections from additional sources...
//
//   >---
//
//   > **IMPORTANT**: ...
//
// AEM's lenient renderer produced ONE bordered note box with the paragraphs
// stacked and no visible divider lines. Under CommonMark/Goldmark (Hugo) the
// blank lines terminate the blockquote, so each `>` block becomes its OWN
// blockquote (its own blue info box) and each `>---` renders as a visible
// horizontal rule inside its own box (issue #1741 screenshot: a stack of blue
// boxes with dividers instead of one note).
//
// mergeBlockquoteNoteDividers() collapses the blank/`>---` separators between
// blockquote paragraphs into a single `>` continuation so Goldmark renders one
// continuous blockquote note, matching legacy intent. It is scoped to gaps that
// contain a `>---` divider, so ordinary blank-separated blockquotes and plain
// (non-blockquoted) thematic breaks are left untouched, and it never rewrites
// content inside a blockquoted code fence.

import { describe, it, expect } from 'vitest'
import { mergeBlockquoteNoteDividers } from '../blockquote-notes.js'

describe('mergeBlockquoteNoteDividers', () => {
  it('merges the hana-clients-choose-hana-instance "additional details" note', () => {
    const input = [
      '> Access help from the SAP community or provide feedback on this tutorial by navigating to the **Feedback** link located on the top right of this page.',
      '',
      '>---',
      '',
      '>For connections from additional sources such as SAP Analytics Cloud, `Jupyter` Notebooks.',
      '',
      '>---',
      '',
      '>For connections to the SAP HANA Cloud, Data Lake, see the tutorial.',
      '',
      '>---',
      '',
      '>**IMPORTANT**: Complete the first 3 tutorials.',
    ].join('\n')
    const expected = [
      '> Access help from the SAP community or provide feedback on this tutorial by navigating to the **Feedback** link located on the top right of this page.',
      '>',
      '>For connections from additional sources such as SAP Analytics Cloud, `Jupyter` Notebooks.',
      '>',
      '>For connections to the SAP HANA Cloud, Data Lake, see the tutorial.',
      '>',
      '>**IMPORTANT**: Complete the first 3 tutorials.',
    ].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(expected)
  })

  it('handles a spaced divider "> ---"', () => {
    const input = ['> first', '', '> ---', '', '> second'].join('\n')
    const expected = ['> first', '>', '> second'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(expected)
  })

  it('preserves list-continuation indentation on the collapsed marker', () => {
    // hana-dbx-connections / hana-cloud-alerts shape: 4-space list indent.
    const input = ['    > first', '', '    >---', '', '    > second'].join('\n')
    const expected = ['    > first', '    >', '    > second'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(expected)
  })

  it('handles a divider preceded by an empty blockquote continuation line', () => {
    // hana-clients-node shape: `    >` (empty continuation) directly above the
    // divider, then a truly-blank line below it.
    const input = ['    > first', '    >', '    >---', '', '    > second'].join('\n')
    const expected = ['    > first', '    >', '    > second'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(expected)
  })

  it('leaves a plain (non-blockquoted) thematic break untouched', () => {
    // `---` outside a blockquote is a real section separator — never merged.
    const input = ['Some paragraph.', '', '---', '', '### Next Section'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })

  it('leaves blank-separated blockquotes WITHOUT a divider untouched', () => {
    // No `>---` between them → not the additional-details pattern → left as-is
    // so we do not over-merge notes the author intended to keep separate.
    const input = ['> note one', '', '> note two'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })

  it('does not merge across a non-blockquote line between paragraphs', () => {
    // A `>---` whose gap also contains real content is not a clean note
    // divider; the blockquote genuinely ended, so leave it verbatim.
    const input = ['> first', '', 'plain paragraph', '', '>---', '', '> second'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })

  it('never rewrites a `>---` that is inside a blockquoted code fence', () => {
    const input = [
      '> before',
      '',
      '>```text',
      '>---',
      '>```',
      '',
      '> after',
    ].join('\n')
    // The `>---` is code content, not a divider. No collapsible gap exists
    // (the fence lines are blockquote content), so the input is unchanged.
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })

  it('is a no-op on markdown with no blockquotes', () => {
    const input = ['# Title', '', 'A paragraph.', '', '- a list item'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })

  it('leaves a leading divider (no blockquote content before it) untouched', () => {
    const input = ['>---', '', '> only paragraph'].join('\n')
    expect(mergeBlockquoteNoteDividers(input)).toBe(input)
  })
})
