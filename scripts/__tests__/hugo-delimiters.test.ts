import { describe, it, expect } from 'vitest'
import { escapeHugoDelimiters } from '../parsers/hugo-delimiters.js'

describe('escapeHugoDelimiters', () => {
  it('leaves {{ inside code fences unchanged', () => {
    const input = `Some text

\`\`\`yaml
key: {{ .Values.x }}
\`\`\`

More text`

    const result = escapeHugoDelimiters(input)
    expect(result).toContain('key: {{ .Values.x }}')
  })

  it('escapes {{ outside code fences', () => {
    const input = 'Use {{ .Values.x }} in your template'
    const result = escapeHugoDelimiters(input)
    expect(result).toContain('&#123;&#123;')
    expect(result).not.toMatch(/(?<!&#123;)\{\{(?!%)/)
  })

  it('escapes {{ .Values.x }} outside code fences', () => {
    const input = 'Set the value to {{ .Values.replicaCount }} replicas'
    const result = escapeHugoDelimiters(input)
    expect(result).toContain('&#123;&#123; .Values.replicaCount &#125;&#125;')
  })

  it('handles mixed code fence and non-code content', () => {
    const input = `Before {{ foo }}

\`\`\`
{{ inside_fence }}
\`\`\`

After {{ bar }}`

    const result = escapeHugoDelimiters(input)
    expect(result).toContain('Before &#123;&#123; foo &#125;&#125;')
    expect(result).toContain('{{ inside_fence }}')
    expect(result).toContain('After &#123;&#123; bar &#125;&#125;')
  })

  it('handles tilde code fences', () => {
    const input = `Outside {{ test }}

~~~bash
echo {{ value }}
~~~

Also outside {{ another }}`

    const result = escapeHugoDelimiters(input)
    expect(result).toContain('Outside &#123;&#123; test &#125;&#125;')
    expect(result).toContain('echo {{ value }}')
    expect(result).toContain('Also outside &#123;&#123; another &#125;&#125;')
  })

  it('preserves Hugo shortcode syntax {{% ... %}}', () => {
    const input = '{{% tutorial-step number="1" title="Test" %}}\ncontent with {{ var }}\n{{% /tutorial-step %}}'
    const result = escapeHugoDelimiters(input)
    expect(result).toContain('{{% tutorial-step number="1" title="Test" %}}')
    expect(result).toContain('{{% /tutorial-step %}}')
    expect(result).toContain('content with &#123;&#123; var &#125;&#125;')
  })

  it('preserves Hugo angle-bracket shortcodes {{< ... >}}', () => {
    const input = '{{< highlight go >}}\ncode here\n{{< /highlight >}}'
    const result = escapeHugoDelimiters(input)
    expect(result).toContain('{{< highlight go >}}')
    expect(result).toContain('{{< /highlight >}}')
  })

  it('returns content unchanged when no {{ present', () => {
    const input = 'Just regular markdown content\nwith multiple lines'
    expect(escapeHugoDelimiters(input)).toBe(input)
  })

  it('handles multiple {{ on the same line', () => {
    const input = '{{ foo }} and {{ bar }}'
    const result = escapeHugoDelimiters(input)
    expect(result).toBe('&#123;&#123; foo &#125;&#125; and &#123;&#123; bar &#125;&#125;')
  })
})
