import type { TutorialStep } from './types.js'

export function parseV2Steps(body: string): TutorialStep[] {
  const lines = body.split('\n')
  const steps: TutorialStep[] = []
  let currentTitle = ''
  let currentLines: string[] = []
  let inStep = false

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)$/)
    if (h3Match) {
      if (inStep) {
        steps.push({
          number: steps.length + 1,
          title: currentTitle,
          content: currentLines.join('\n').trim()
        })
      }
      currentTitle = h3Match[1].trim()
      currentLines = []
      inStep = true
      continue
    }
    if (inStep) {
      currentLines.push(line)
    }
  }

  if (inStep) {
    steps.push({
      number: steps.length + 1,
      title: currentTitle,
      content: currentLines.join('\n').trim()
    })
  }

  return steps
}
