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

describe('diff fence attribute — unified-diff column stripping', () => {
  it('copyDiffFinal: diff-added and context lines included, diff-removed excluded', () => {
    // Simulates the DOM output produced by the {diff} Hugo template path.
    // The Hugo template strips the leading +/-/space column and assigns:
    //   + lines → <span class="line diff-added">
    //   - lines → <span class="line diff-removed">
    //   space lines → <span class="line">
    // copyDiffFinal should exclude removed lines and include added + context.
    const html = `<pre><code>
      <span class="line diff-added">added line</span>
      <span class="line diff-removed">removed line</span>
      <span class="line">context line</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).toContain('added line')
    expect(text).not.toContain('removed line')
    expect(text).toContain('context line')
  })

  it('backward compat: a plain .line span whose text starts with + is treated as context (no exclusion)', () => {
    // A fence WITHOUT {diff} attribute may have code lines beginning with + (e.g.,
    // TypeScript union types, git diff output shown as plain text, etc.).
    // Without the {diff} gate, the Hugo template does NOT classify such lines as diff-added.
    // They get class="line" only, not "line diff-added". copyDiffFinal must not exclude them.
    const html = `<pre><code>
      <span class="line">+foo</span>
      <span class="line">bar</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).toContain('+foo')
    expect(text).toContain('bar')
  })

  it('blank lines in a unified-diff block pass through as context (no crash, included in output)', () => {
    // A blank line in a unified-diff hunk (empty string after leading-column strip)
    // should produce a plain <span class="line"> with empty text content.
    // copyDiffFinal must handle these without crashing and include them.
    const html = `<pre><code>
      <span class="line diff-added">first line</span>
      <span class="line"></span>
      <span class="line diff-added">third line</span>
    </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).toContain('first line')
    expect(text).toContain('third line')
    // blank line span is included as empty string — result should not throw and should join cleanly
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2)
  })

  it('context-only diff fence: copyDiffFinal includes all lines (simulating gutter-stripped output)', () => {
    // A {diff} fence with only context lines (no +/-) should strip the leading space gutter
    // and render all lines as plain .line spans. copyDiffFinal must include them all.
    const html = `<pre><code>
    <span class="line">const a = 1</span>
    <span class="line">const b = 2</span>
  </code></pre>`
    const block = makeBlock(html)
    const text = copyDiffFinal(block)
    expect(text).toContain('const a = 1')
    expect(text).toContain('const b = 2')
  })
})
