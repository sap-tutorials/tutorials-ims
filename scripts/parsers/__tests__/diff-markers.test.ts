// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { copyDiffFinal } from '../../../hugo/assets/js/copy-clean.js'

function makeBlock(html: string, options?: { copyRaw?: boolean; rawContent?: string }): HTMLElement {
  const div = document.createElement('div')
  div.className = 'code-block-body'
  div.innerHTML = html
  if (options?.copyRaw) div.dataset.copyRaw = 'true'
  if (options?.rawContent !== undefined) div.dataset.rawContent = options.rawContent
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

  it('{copy=raw} yields full source including markers via data-raw-content', () => {
    // Hugo stores .Inner (with markers) in data-raw-content via {{ .Inner | htmlEscape }}.
    // The rendered DOM has markers stripped (Chroma gets $cleanInner, not .Inner).
    // copyDiffFinal must read data-raw-content, not textContent, when copyRaw is set.
    const rawSource = 'const b = 2 // [!code --]\nconst b = 3 // [!code ++]\n'
    const html = `<pre><code>
      <span class="line diff-added">const b = 3</span>
    </code></pre>`
    const block = makeBlock(html, { copyRaw: true, rawContent: rawSource })
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
