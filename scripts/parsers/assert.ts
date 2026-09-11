import type { AssertBlock, AssertType } from './types.js'

const ASSERT_MARKER = /^\[ASSERT_(\d+)\]\s*$/
// A sibling per-step marker closes an open ASSERT block (same flush pattern as codecheck.ts).
const ANY_MARKER = /^\[(VALIDATE|CODECHECK|ASSERT)_\d+\]\s*$/

const VALID_TYPES = new Set<AssertType>(['cmd', 'http', 'file'])
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

// N in [ASSERT_N] is the step number; a step may have multiple blocks.
export function parseAssertBlocks(content: string): Map<number, AssertBlock[]> {
  const result = new Map<number, AssertBlock[]>()
  const lines = content.split('\n')
  let currentNum: number | null = null
  let blockLines: string[] = []

  const flush = () => {
    if (currentNum === null) return
    const arr = result.get(currentNum) ?? []
    const block = parseBlock(blockLines, currentNum, arr.length)
    if (block) { arr.push(block); result.set(currentNum, arr) }
    currentNum = null
    blockLines = []
  }

  for (const line of lines) {
    const m = line.match(ASSERT_MARKER)
    if (m) { flush(); currentNum = parseInt(m[1], 10); continue }
    if (ANY_MARKER.test(line)) { flush(); continue }   // sibling block — close ours
    if (currentNum !== null) blockLines.push(line)
  }
  flush()
  return result
}

function parseBlock(lines: string[], stepNumber: number, index: number): AssertBlock | null {
  const raw = lines.join('\n')
  const type = section(raw, 'Type').toLowerCase()
  if (!VALID_TYPES.has(type as AssertType)) {
    console.warn(`[assert] step ${stepNumber} assert ${index}: missing or unknown ###Type "${type || '(empty)'}" — skipped`)
    return null
  }
  const matchRaw = section(raw, 'Match')
  const match = matchRaw || undefined

  if (type === 'cmd') {
    const run = section(raw, 'Run')
    const expectExit = parseExpect(section(raw, 'Expect'), 'exit')
    if (!run || expectExit === null) {
      console.warn(`[assert] step ${stepNumber} assert ${index}: cmd needs ###Run and "###Expect exit <int>" — skipped`)
      return null
    }
    return { index, stepNumber, type, run, expectExit, match }
  }

  if (type === 'http') {
    const method = section(raw, 'Method').toUpperCase()
    const path = section(raw, 'Path')
    const expectStatus = parseExpect(section(raw, 'Expect'), 'status')
    if (!HTTP_METHODS.has(method) || !path || expectStatus === null) {
      console.warn(`[assert] step ${stepNumber} assert ${index}: http needs valid ###Method, ###Path and "###Expect status <int>" — skipped`)
      return null
    }
    return { index, stepNumber, type, method, path, expectStatus, match }
  }

  // file
  const filePath = section(raw, 'Path')
  const expect = section(raw, 'Expect').toLowerCase()
  if (!filePath || (expect !== 'exists' && expect !== 'contains')) {
    console.warn(`[assert] step ${stepNumber} assert ${index}: file needs ###Path and "###Expect exists|contains" — skipped`)
    return null
  }
  const expectContains = expect === 'contains'
  if (expectContains && !match) {
    console.warn(`[assert] step ${stepNumber} assert ${index}: file+contains requires ###Match — skipped`)
    return null
  }
  return { index, stepNumber, type, filePath, expectContains, match }
}

// "exit 0" / "status 200" → 0 / 200; wrong keyword or non-int → null.
function parseExpect(raw: string, keyword: 'exit' | 'status'): number | null {
  const m = raw.trim().match(new RegExp(`^${keyword}\\s+(-?\\d+)$`))
  return m ? parseInt(m[1], 10) : null
}

function section(raw: string, name: string): string {
  // Match from ###Name through to the next ### heading or end-of-string.
  const re = new RegExp(`###${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|$)`)
  const m = raw.match(re)
  return m ? m[1].trim() : ''
}

interface StepLike { number: number; asserts?: AssertBlock[] }

// Attaches asserts[] to matching steps in place; returns the flat sidecar
// array (all blocks across all steps) for <slug>.assert.json.
export function attachAssertSpecs<T extends StepLike>(
  steps: T[], specs: Map<number, AssertBlock[]>
): AssertBlock[] {
  const sidecar: AssertBlock[] = []
  for (const [stepNumber, blocks] of specs) {
    const target = steps.find(s => s.number === stepNumber)
    if (!target) continue
    target.asserts = blocks
    sidecar.push(...blocks)
  }
  return sidecar
}
