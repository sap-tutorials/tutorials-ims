import type { ValidationQuestion } from './types.js'

const VALIDATE_MARKER = /^\[VALIDATE_(\d+)\]\s*$/

// Rule types whose semantics are "match a regex/prefix pattern" — these are
// auto-routed to AI grading (issue #209). Historically the loader treated
// them as plain string equality, so authors who chose them never got the
// pattern semantics they wanted. AI grading gives them the spirit-of-the-
// answer evaluation that matches their original intent.
const REGEX_RULE_TYPES = new Set(['regex', 'regex-begins-with'])

export function parseRulesVr(content: string): Map<number, ValidationQuestion[]> {
  return parseRulesVrEnriched(content).map
}

/**
 * Enriched variant of parseRulesVr that also returns two sibling maps —
 * keyed by `${stepNumber}:${questionId}` — capturing per-question metadata
 * that is INTENTIONALLY excluded from the public ValidationQuestion shape
 * for AI-graded questions (anti-leak, issue #209):
 *
 *   - ruleTypeByStepAndId: original ###Rule string (lowercased), e.g. "regex"
 *   - correctAnswerByStepAndId: the reference answer (matchContent for text,
 *     selected option for multiple-choice). For AI-graded questions this is
 *     the only place the answer survives — the public q.correctAnswer field
 *     is omitted.
 *
 * Both sibling maps are populated for EVERY emitted question (AI-graded or
 * not), so they remain a complete index of build-time metadata for any
 * downstream consumer. Filtering to AI-graded specs happens inside
 * collectAiGradedSpecs.
 */
export function parseRulesVrEnriched(content: string): {
  map: Map<number, ValidationQuestion[]>
  ruleTypeByStepAndId: Map<string, string>
  correctAnswerByStepAndId: Map<string, string>
} {
  const result = new Map<number, ValidationQuestion[]>()
  const ruleTypeByStepAndId = new Map<string, string>()
  const correctAnswerByStepAndId = new Map<string, string>()
  const lines = content.split('\n')

  let currentNum: number | null = null
  let blockLines: string[] = []

  // Emits the in-progress block to the result map, then resets state.
  // Idempotent — safe to call when no block is in progress (returns early on currentNum === null).
  const flush = () => {
    if (currentNum === null) return
    const questions = parseBlock(blockLines, currentNum, ruleTypeByStepAndId, correctAnswerByStepAndId)
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

  return { map: result, ruleTypeByStepAndId, correctAnswerByStepAndId }
}

function parseBlock(
  lines: string[],
  stepNum: number,
  ruleTypeByStepAndId: Map<string, string>,
  correctAnswerByStepAndId: Map<string, string>
): ValidationQuestion[] {
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

    // [#238] AI-graded multiple-choice is a footgun: the LLM prompt is
    // structured for free-text answers and option-letter "submissions"
    // produce nonsensical verdicts. We accept the directive at parse time
    // (so authors don't get a build break) but warn loudly so the typo
    // surfaces during fetch-tutorials. The dispatch (#238 runtime guard)
    // also rejects with errorReason: 'wrong_question_type'.
    if (aiGrading) {
      // Use console.warn rather than throw — partial-fetch resiliency matters.
      console.warn(
        `[#238] step ${stepNum}: multiple-choice question marked "###Grading: ai-judged" — ` +
        `the AI grader is text-only by design. Either remove the directive or change ` +
        `the rule type to a text/regex variant. ` +
        `Letting it pass parses with aiGrading: true; runtime will reject with errorReason: 'wrong_question_type'.`
      )
    }
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
    // Populate sibling maps for EVERY emitted question (AI-graded or not),
    // so downstream consumers have a complete index. AI-graded filtering
    // happens in collectAiGradedSpecs.
    const key = `${stepNum}:${q.id}`
    if (ruleType) ruleTypeByStepAndId.set(key, ruleType)
    correctAnswerByStepAndId.set(key, correctAnswer)
    return [q]
  }

  if (!matchContent) return []
  const q: ValidationQuestion = {
    id: `validate-${stepNum}`,
    question,
    type,
    ...(aiGrading ? { aiGrading: true } : { correctAnswer: matchContent }),
  }
  const key = `${stepNum}:${q.id}`
  if (ruleType) ruleTypeByStepAndId.set(key, ruleType)
  correctAnswerByStepAndId.set(key, matchContent)
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

export interface AiGradedSpec {
  stepNumber: number
  questionId: string
  questionText: string
  correctAnswer: string
  ruleType: string | undefined
  aiGrading: boolean
}

/**
 * Collect AI-graded questions across all steps for a tutorial.
 * Returns the spec entries that should be persisted server-side via
 * the publish pipeline (issue #209). Mirrors attachCodeCheckSpecs from
 * PR #205.
 */
export function collectAiGradedSpecs(
  validationByStep: Map<number, ValidationQuestion[]>,
  ruleTypeByStepAndId: Map<string, string>,
  correctAnswerByStepAndId: Map<string, string>
): AiGradedSpec[] {
  const specs: AiGradedSpec[] = []
  for (const [stepNumber, questions] of validationByStep) {
    for (const q of questions) {
      if (!q.aiGrading) continue
      const key = `${stepNumber}:${q.id}`
      const correctAnswer = correctAnswerByStepAndId.get(key)
      if (correctAnswer === undefined) {
        // Should never happen: parseBlock populates this map for every
        // question it emits, AI-graded or not. Defensive log + skip.
        continue
      }
      specs.push({
        stepNumber,
        questionId: q.id,
        questionText: q.question,
        correctAnswer,                    // <-- from sibling map, NOT q.correctAnswer
        ruleType: ruleTypeByStepAndId.get(key),
        aiGrading: true
      })
    }
  }
  return specs
}
