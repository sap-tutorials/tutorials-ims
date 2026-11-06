// Tree fence parser — parses indented/box-drawing tree notation into structured nodes.
// Used by the Hugo render hook (render-codeblock.html) via a parallel Go template
// implementation. This TypeScript version is the canonical spec and test fixture.

export interface TreeNode {
  depth: number
  label: string
  isFolder: boolean
  state: '+' | '~' | '-' | null
  annotation: string | null
}

export function parseTreeLines(lines: string[]): TreeNode[] {
  const nodes: TreeNode[] = []
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue

    // Normalize box-drawing to 2-space indent units:
    // - Each │ (vertical continuation) + 0-3 trailing spaces → 2 spaces (one depth unit)
    // - Each ├── or └── connector (optionally followed by space) → stripped (no depth added)
    // - Each ─ (horizontal line without connector) → stripped
    // This maps standard `tree` output to 2-space-per-level indentation.
    const normalized = line
      .replace(/│\s{0,3}/g, '  ')      // vertical line → 2-space indent unit
      .replace(/[├└]─*\s*/g, '')       // connectors → nothing (depth comes from │ count before)
      .replace(/─/g, '')               // lone horizontal bars → strip

    // Count leading spaces for depth (floor division by 2)
    const leadingMatch = normalized.match(/^( *)(.*)/)!
    const leading = leadingMatch[1].length
    const depth = Math.floor(leading / 2)
    let rest = leadingMatch[2].trimStart()

    // Extract state prefix (+ ~ -)
    let state: '+' | '~' | '-' | null = null
    if (/^[+~-] /.test(rest)) {
      state = rest[0] as '+' | '~' | '-'
      rest = rest.slice(2)
    }

    // Extract annotation (text after two+ spaces + #)
    let annotation: string | null = null
    const annotationMatch = rest.match(/\s{2,}#\s+(.*)$/)
    if (annotationMatch) {
      annotation = annotationMatch[1].trim()
      rest = rest.slice(0, annotationMatch.index).trimEnd()
    }

    // Detect folder (trailing /)
    const trimmedRest = rest.trimEnd()
    const isFolder = trimmedRest.endsWith('/')
    const label = trimmedRest

    nodes.push({ depth, label, isFolder, state, annotation })
  }
  return nodes
}
