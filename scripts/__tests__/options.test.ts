import { describe, it, expect } from 'vitest'
import { convertOptionBlocks } from '../parsers/options.js'

describe('convertOptionBlocks', () => {
  it('converts a single OPTION block pair to OptionTabs', () => {
    const input = `Some intro text.

[OPTION BEGIN [SAP Business Application Studio]]

BAS content here.

[OPTION END]

[OPTION BEGIN [Visual Studio Code]]

VS Code content here.

[OPTION END]

Trailing text.`

    const result = convertOptionBlocks(input)
    expect(result).toContain('<OptionTabs :tabs="[\'SAP Business Application Studio\',\'Visual Studio Code\']">')
    expect(result).toContain('<template #tab-0>')
    expect(result).toContain('BAS content here.')
    expect(result).toContain('<template #tab-1>')
    expect(result).toContain('VS Code content here.')
    expect(result).toContain('</OptionTabs>')
    expect(result).toContain('Some intro text.')
    expect(result).toContain('Trailing text.')
  })

  it('returns unchanged content when no OPTION blocks present', () => {
    const input = 'Just plain markdown.'
    expect(convertOptionBlocks(input)).toBe(input)
  })

  it('handles multiple independent OPTION groups', () => {
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

    const result = convertOptionBlocks(input)
    const tabsCount = (result.match(/<OptionTabs/g) ?? []).length
    expect(tabsCount).toBe(2)
  })
})
