import type { CodeCheckSpec, PublicCodeCheckSpec } from './types.js'

const CODECHECK_MARKER = /^\[CODECHECK_(\d+)\]\s*$/
const ANY_MARKER = /^\[(VALIDATE|CODECHECK)_\d+\]\s*$/

export function parseCodeCheckBlocks(content: string): Map<number, CodeCheckSpec> {
  const result = new Map<number, CodeCheckSpec>()
  const lines = content.split('\n')
  let currentNum: number | null = null
  let blockLines: string[] = []

  const flush = () => {
    if (currentNum === null) return
    const spec = parseBlock(blockLines, currentNum)
    if (spec) result.set(currentNum, spec)
    currentNum = null
    blockLines = []
  }

  for (const line of lines) {
    const cc = line.match(CODECHECK_MARKER)
    if (cc) { flush(); currentNum = parseInt(cc[1], 10); continue }
    if (ANY_MARKER.test(line)) { flush(); continue }   // hit a sibling block — close ours
    if (currentNum !== null) blockLines.push(line)
  }
  flush()
  return result
}

function parseBlock(lines: string[], stepNumber: number): CodeCheckSpec | null {
  const raw = lines.join('\n')
  const goal = section(raw, 'Goal')
  if (!goal) return null
  const language = section(raw, 'Language') || undefined
  const hintsRaw = section(raw, 'Hints')
  const hints = hintsRaw
    ? hintsRaw.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean)
    : undefined
  const referenceSolution = section(raw, 'ReferenceSolution') || undefined
  return { stepNumber, goal, language, hints, referenceSolution }
}

function section(raw: string, name: string): string {
  // Match from ###Name through to the next ### heading or end-of-string.
  // No 'm' flag so '$' means true end-of-string and [\s\S]*? stops at ###.
  const re = new RegExp(`###${name}[^\n]*\n([\\s\\S]*?)(?=\n###|$)`)
  const m = raw.match(re)
  return m ? m[1].trim() : ''
}

interface StepLike { number: number; codeCheck?: PublicCodeCheckSpec }

/**
 * Mutates each step in place: attaches a trimmed PublicCodeCheckSpec when
 * the step number matches a parsed spec. Returns the full sidecar array
 * (server-only) for writing to .tutorial-cache/<slug>.codecheck.json.
 */
export function attachCodeCheckSpecs<T extends StepLike>(
  steps: T[],
  specs: Map<number, CodeCheckSpec>
): CodeCheckSpec[] {
  const sidecar: CodeCheckSpec[] = []
  for (const [stepNumber, spec] of specs) {
    const target = steps.find(s => s.number === stepNumber)
    if (!target) continue
    target.codeCheck = {
      goal: spec.goal,
      language: spec.language,
      hints: spec.hints,
      hasReference: Boolean(spec.referenceSolution)
    }
    sidecar.push(spec)
  }
  return sidecar
}
