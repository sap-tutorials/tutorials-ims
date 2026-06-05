import type { ValidationQuestion } from './types.js'

const VALIDATE_MARKER = /^\[VALIDATE_(\d+)\]\s*$/

// Rule types whose semantics are "match a regex/prefix pattern" — these are
// auto-routed to AI grading (issue #209). Historically the loader treated
// them as plain string equality, so authors who chose them never got the
// pattern semantics they wanted. AI grading gives them the spirit-of-the-
// answer evaluation that matches their original intent.
const REGEX_RULE_TYPES = new Set(['regex', 'regex-begins-with'])

export function parseRulesVr(content: string): Map<number, ValidationQuestion[]> {
  const result = new Map<number, ValidationQuestion[]>()
  const lines = content.split('\n')

  let currentNum: number | null = null
  let blockLines: string[] = []

  // Emits the in-progress block to the result map, then resets state.
  // Idempotent — safe to call when no block is in progress (returns early on currentNum === null).
  const flush = () => {
    if (currentNum === null) return
    const questions = parseBlock(blockLines, currentNum)
    if (questions.length) {
      const existing = result.get(currentNum) ?? []
      existing.push(...questions)
      result.set(currentNum, existing)
    }
    currentNum = null
    blockLines = []
  }

  for (const line of lines) {
    const match = line.match(VALIDATE_MARKER)
    if (match) {
      const num = parseInt(match[1], 10)
      if (currentNum === null) {
        currentNum = num
        blockLines = []
      } else {
        // Consecutive [VALIDATE_*] markers (no intervening close marker):
        // flush the previous block, then re-enter start-of-block state for
        // this marker so its number isn't lost.
        flush()
        currentNum = num
        blockLines = []
      }
      continue
    }
    if (currentNum !== null) {
      blockLines.push(line)
    }
  }

  // EOF flush — captures the final block when there's no closing marker.
  flush()

  return result
}

function parseBlock(lines: string[], stepNum: number): ValidationQuestion[] {
  const raw = lines.join('\n')

  const ruleMatch = raw.match(/###Rule\s*\n([\s\S]*?)(?=###|$)/)
  const questionMatch = raw.match(/###Question\s*\n([\s\S]*?)(?=###|$)/)
  const matchSection = raw.match(/###Match\s*\n([\s\S]*?)(?=###|$)/)
  // NEW: parse ###Grading directive (case-insensitive value).
  const gradingMatch = raw.match(/###Grading\s*\n([\s\S]*?)(?=###|$)/)

  if (!questionMatch) return []

  const ruleType = (ruleMatch?.[1] ?? '').trim().toLowerCase()
  const question = questionMatch[1].trim()
  const matchContent = (matchSection?.[1] ?? '').trim()

  const gradingValue = gradingMatch?.[1]?.trim().toLowerCase()
  const explicitlyAiGraded = gradingValue === 'ai-judged'
  const autoAiGraded = REGEX_RULE_TYPES.has(ruleType)
  const aiGrading = explicitlyAiGraded || autoAiGraded

  const type = ruleType === 'single-choice' || ruleType === 'multiple-choice'
    ? 'multiple-choice' as const
    : 'text' as const

  if (type === 'multiple-choice') {
    const { options, correctAnswer } = parseChoiceOptions(matchContent)
    if (!options.length || !correctAnswer) return []
    // ANTI-LEAK: when aiGrading is true, OMIT correctAnswer from the public
    // shape. The reference answer ships server-side via ValidateAnswerSpecs
    // and never enters the public Hugo frontmatter / <script id="tutorial-data">.
    const q: ValidationQuestion = {
      id: `validate-${stepNum}`,
      question,
      type,
      options,
      ...(aiGrading ? { aiGrading: true } : { correctAnswer }),
    }
    return [q]
  }

  if (!matchContent) return []
  const q: ValidationQuestion = {
    id: `validate-${stepNum}`,
    question,
    type,
    ...(aiGrading ? { aiGrading: true } : { correctAnswer: matchContent }),
  }
  return [q]
}

function parseChoiceOptions(content: string): { options: string[]; correctAnswer: string } {
  const options: string[] = []
  let correctAnswer = ''

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const correctMatch = trimmed.match(/^\[x\]\s*(.+)$/)
    if (correctMatch) {
      const opt = correctMatch[1].trim()
      options.push(opt)
      correctAnswer = opt
      continue
    }
    const incorrectMatch = trimmed.match(/^\[ \]\s*(.+)$/)
    if (incorrectMatch) {
      options.push(incorrectMatch[1].trim())
    }
  }

  return { options, correctAnswer }
}

export { parseCodeCheckBlocks } from './codecheck.js'
