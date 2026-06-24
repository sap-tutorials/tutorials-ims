import type { TutorialStep } from './types.js'
import { createFenceTracker } from './fence-tracker.js'

const VALIDATE_LINE = /^\s*\[VALIDATE_\d+\]\s*$/
const DONE_LINE = /^\s*\[DONE\]\s*$/

export function parseV2Steps(body: string): TutorialStep[] {
  const lines = body.split('\n')
  const steps: TutorialStep[] = []
  let currentTitle = ''
  let currentLines: string[] = []
  let inStep = false
  // Track fenced-code-block state so an H3 quoted inside a code block
  // (e.g. a tutorial that demonstrates authoring syntax) is treated as
  // literal content, not a step delimiter. Root cause of the cookbook
  // tutorial's phantom-step bug.
  const fence = createFenceTracker()

  for (const line of lines) {
    if (fence(line)) {
      if (inStep) currentLines.push(line)
      continue
    }

    const h3Match = line.match(/^### (.+)$/)
    if (h3Match) {
      if (inStep) {
        steps.push({
          number: steps.length + 1,
          title: currentTitle,
          content: stripMarkers(currentLines).join('\n').trim()
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
      content: stripMarkers(currentLines).join('\n').trim()
    })
  }

  return steps
}

function stripMarkers(lines: string[]): string[] {
  return lines.filter(l => !VALIDATE_LINE.test(l) && !DONE_LINE.test(l))
}
