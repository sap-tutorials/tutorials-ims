import type { TutorialStep } from './types.js'

const ACCORDION_BEGIN = /\[ACCORDION-BEGIN \[Step (\d+):\s*\]\((.+?)\)\]/
const ACCORDION_END = /\[ACCORDION-END\]/

export function parseV1Steps(body: string): TutorialStep[] {
  const lines = body.split('\n')
  const steps: TutorialStep[] = []
  let currentNumber = 0
  let currentTitle = ''
  let currentLines: string[] = []
  let inStep = false

  for (const line of lines) {
    const beginMatch = line.match(ACCORDION_BEGIN)
    if (beginMatch) {
      currentNumber = parseInt(beginMatch[1], 10)
      currentTitle = beginMatch[2].trim()
      currentLines = []
      inStep = true
      continue
    }

    if (ACCORDION_END.test(line)) {
      if (inStep) {
        steps.push({
          number: currentNumber,
          title: currentTitle,
          content: currentLines.join('\n').trim()
        })
      }
      inStep = false
      continue
    }

    if (inStep) {
      currentLines.push(line)
    }
  }

  return steps
}
