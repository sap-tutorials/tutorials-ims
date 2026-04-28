import { describe, it, expect } from 'vitest'
import { convertOptionBlocks } from '../parsers/options.js'

describe('convertOptionBlocks (hugo target)', () => {
  it('outputs Hugo shortcode syntax', () => {
    const input = `[OPTION BEGIN [Video]]
video content
[OPTION END]
[OPTION BEGIN [Written]]
text content
[OPTION END]`
    const result = convertOptionBlocks(input, 'hugo')
    expect(result).toContain('{{% option-tabs tabs="Video,Written" %}}')
    expect(result).toContain('{{% tab index="0" name="Video" %}}')
    expect(result).toContain('{{% /tab %}}')
    expect(result).toContain('{{% /option-tabs %}}')
  })

  it('preserves existing VitePress output when target is vitepress', () => {
    const input = `[OPTION BEGIN [A]]
content A
[OPTION END]`
    const result = convertOptionBlocks(input, 'vitepress')
    expect(result).toContain('OptionTabs')
  })

  it('preserves existing VitePress output when no target', () => {
    const input = `[OPTION BEGIN [A]]
content A
[OPTION END]`
    const result = convertOptionBlocks(input)
    expect(result).toContain('OptionTabs')
  })

  it('handles multiple option groups for hugo', () => {
    const input = `[OPTION BEGIN [A]]
A content
[OPTION END]
[OPTION BEGIN [B]]
B content
[OPTION END]

Other stuff.

[OPTION BEGIN [X]]
X content
[OPTION END]
[OPTION BEGIN [Y]]
Y content
[OPTION END]`

    const result = convertOptionBlocks(input, 'hugo')
    const tabsCount = (result.match(/\{{% option-tabs/g) ?? []).length
    expect(tabsCount).toBe(2)
    expect(result).toContain('{{% tab index="0" name="A" %}}')
    expect(result).toContain('{{% tab index="1" name="B" %}}')
    expect(result).toContain('{{% tab index="0" name="X" %}}')
    expect(result).toContain('{{% tab index="1" name="Y" %}}')
  })

  it('does not produce Vue syntax for hugo target', () => {
    const input = `[OPTION BEGIN [Test]]
some content
[OPTION END]`
    const result = convertOptionBlocks(input, 'hugo')
    expect(result).not.toContain('OptionTabs')
    expect(result).not.toContain('<template')
  })
})
