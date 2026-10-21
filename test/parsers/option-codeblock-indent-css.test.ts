import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Regression test for issue #2820 — code boxes that TRAIL an [OPTION] block
// within the same numbered substep rendered flush-left (margin-left: 0) while
// the surrounding prose/figures sat at the 1.5rem list-content column, giving
// the stair-stepped indentation Tom reported on tutorials-qa/hana-clients-hdbsql
// step 5 substep 2 (the `SELECT …` / `hdbsql …` boxes after the OS OPTION group).
//
// Root cause: the OPTION shortcode's block <div> closes the surrounding <ol>,
// so trailing content becomes a column-0 sibling of the list. The trailing-
// sibling indent rule re-indents `~ p`, `~ figure`, `~ pre`, `~ blockquote`,
// but tutorial code fences render as `<div class="code-block">` (render-
// codeblock.html) — the `<pre>` is nested inside — so `~ pre` never matched
// them. Fix: add `~ .code-block` to the trailing-sibling indent set.
//
// Verified live: injecting exactly this rule into the QA DOM moved all three
// trailing code boxes from gap 0 to gap 24px (the list content column).

const src = 'hugo/assets/css/sap-fundamental.src.css'
const built = 'hugo/assets/css/sap-fundamental.css'

describe('#2820 — trailing code-box indent after OPTION blocks', () => {
  it('source indents .code-block that trails an os-options / option-tabs group', () => {
    const t = readFileSync(src, 'utf8')
    expect(t).toContain('.step-content > .os-options ~ .code-block')
    expect(t).toContain('.step-content > .option-tabs ~ .code-block')
  })

  it('the trailing-sibling rule still covers prose, figures, pre and blockquote', () => {
    // Guard against a refactor dropping the sibling types the earlier fixes added.
    const t = readFileSync(src, 'utf8')
    for (const sel of [
      '.step-content > .os-options ~ p',
      '.step-content > .os-options ~ figure',
      '.step-content > .os-options ~ pre',
      '.step-content > .os-options ~ blockquote',
    ]) {
      expect(t).toContain(sel)
    }
  })

  it('built css was regenerated with the code-block selector', () => {
    const t = readFileSync(built, 'utf8')
    expect(t).toContain('.os-options ~ .code-block')
    expect(t).toContain('.option-tabs ~ .code-block')
  })
})
