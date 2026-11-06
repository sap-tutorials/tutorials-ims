import { describe, it, expect } from 'vitest'
import { parseTreeLines } from '../tree-parser.js'
import type { TreeNode } from '../tree-parser.js'

describe('parseTreeLines', () => {
  it('top-level file', () => {
    const [node] = parseTreeLines(['package.json'])
    expect(node).toMatchObject({ depth: 0, label: 'package.json', isFolder: false, state: null, annotation: null })
  })

  it('nested folder', () => {
    const nodes = parseTreeLines(['src/', '  index.ts'])
    expect(nodes[0]).toMatchObject({ depth: 0, label: 'src/', isFolder: true })
    expect(nodes[1]).toMatchObject({ depth: 1, label: 'index.ts', isFolder: false })
  })

  it('box-drawing characters treated as indentation', () => {
    const nodes = parseTreeLines(['├── srv/', '│   └── cat-service.ts'])
    expect(nodes[0]).toMatchObject({ depth: 0, label: 'srv/', isFolder: true })
    expect(nodes[1]).toMatchObject({ depth: 1, label: 'cat-service.ts' })
  })

  it('state prefix + annotation', () => {
    const [node] = parseTreeLines(['+ srv/cat-service.js  # new service'])
    expect(node).toMatchObject({ state: '+', label: 'srv/cat-service.js', annotation: 'new service' })
  })

  it('3-space indent treated as depth 1 (snap to nearest)', () => {
    // Review Focus #4: odd indentation must not crash; snap to nearest valid depth
    const nodes = parseTreeLines(['src/', '   index.ts'])
    expect(nodes[1].depth).toBe(1)
  })

  it('deleted state with box-drawing', () => {
    const nodes = parseTreeLines(['- old-file.js'])
    expect(nodes[0].state).toBe('-')
  })

  it('modified state', () => {
    const nodes = parseTreeLines(['~ config.yaml'])
    expect(nodes[0].state).toBe('~')
  })

  it('empty lines are skipped', () => {
    const nodes = parseTreeLines(['package.json', '', '  src/'])
    expect(nodes).toHaveLength(2)
  })
})
