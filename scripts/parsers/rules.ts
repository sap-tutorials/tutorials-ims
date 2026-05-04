import type { ValidationQuestion } from './types.js'

const VALIDATE_MARKER = /^\[VALIDATE_(\d+)\]\s*$/

export function parseRulesVr(content: string): Map<number, ValidationQuestion[]> {
  const result = new Map<number, ValidationQuestion[]>()
  const lines = content.split('\n')

  let currentNum: number | null = null
  let blockLines: string[] = []

  for (const line of lines) {
    const match = line.match(VALIDATE_MARKER)
    if (match) {
      const num = parseInt(match[1], 10)
      if (currentNum === null) {
        currentNum = num
        blockLines = []
      } else {
        const questions = parseBlock(blockLines, currentNum)
        if (questions.length) {
          const existing = result.get(currentNum) ?? []
          existing.push(...questions)
          result.set(currentNum, existing)
        }
        currentNum = null
        blockLines = []
      }
      continue
    }
    if (currentNum !== null) {
      blockLines.push(line)
    }
  }

  return result
}

function parseBlock(lines: string[], stepNum: number): ValidationQuestion[] {
  const raw = lines.join('\n')

  const ruleMatch = raw.match(/###Rule\s*\n([\s\S]*?)(?=###|$)/)
  const questionMatch = raw.match(/###Question\s*\n([\s\S]*?)(?=###|$)/)
  const matchSection = raw.match(/###Match\s*\n([\s\S]*?)$/)

  if (!questionMatch) return []

  const ruleType = (ruleMatch?.[1] ?? '').trim().toLowerCase()
  const question = questionMatch[1].trim()
  const matchContent = (matchSection?.[1] ?? '').trim()

  const type = ruleType === 'single-choice' || ruleType === 'multiple-choice'
    ? 'multiple-choice' as const
    : 'text' as const

  if (type === 'multiple-choice') {
    const { options, correctAnswer } = parseChoiceOptions(matchContent)
    if (!options.length || !correctAnswer) return []
    return [{
      id: `validate-${stepNum}`,
      question,
      type,
      options,
      correctAnswer,
    }]
  }

  if (!matchContent) return []
  return [{
    id: `validate-${stepNum}`,
    question,
    type,
    correctAnswer: matchContent,
  }]
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
