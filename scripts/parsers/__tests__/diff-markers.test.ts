// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { copyDiffFinal } from '../../../hugo/assets/js/copy-clean.js'

function makeBlock(html: string, copyRaw?: boolean): HTMLElement {
  const div = document.createElement('div')
  div.className = 'code-block-body'
  div.innerHTML = html
  if (copyRaw) div.dataset.copyRaw = 'true'
  return div
}

describe('copyDiffFinal', () => {
  it('copies only non-removed lines', () => {
    const html = `<pre><code>
      <span class="line">const a = 1</span>
      <span class="line diff-removed">const b = 2 // [!code --]</span>
      <span class="line diff-added">const b = 3 // [!code ++]</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).not.toContain('const b = 2')
    expect(text).toContain('const b = 3')
  })

  it('strips marker comments from copied text', () => {
    const html = `<pre><code>
      <span class="line diff-added">const b = 3 // [!code ++]</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).not.toContain('[!code ++]')
    expect(text).toContain('const b = 3')
  })

  it('{copy=raw} yields full source including markers', () => {
    const html = `<pre><code>
      <span class="line diff-removed">const b = 2 // [!code --]</span>
    </code></pre>`
    const block = makeBlock(html, true)
    const text = copyDiffFinal(block)
    expect(text).toContain('[!code --]')
    expect(text).toContain('const b = 2')
  })

  it('passes through lines without markers unchanged', () => {
    const html = `<pre><code>
      <span class="line">const a = 1</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).toContain('const a = 1')
  })
})

describe('corpus regression — standard fences unchanged', () => {
  it('copyDiffFinal with no .line spans falls back to full textContent', () => {
    // Simulates a block that went through the standard (non-diff) path:
    // no .line spans, no data-diff attr. copyDiffFinal should still work.
    const block = document.createElement('div')
    block.className = 'code-block-body'
    block.innerHTML = '<pre><code>const a = 1\n</code></pre>'
    expect(copyDiffFinal(block)).toContain('const a = 1')
  })
})
