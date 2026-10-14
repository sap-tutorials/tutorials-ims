import type { TutorialStep } from './types.js'
import { classifyLines } from './md-grammar.js'

const VALIDATE_LINE = /^\s*\[VALIDATE_\d+\]\s*$/
const DONE_LINE = /^\s*\[DONE\]\s*$/

export function parseV2Steps(body: string): TutorialStep[] {
  const lines = body.split('\n')
  const steps: TutorialStep[] = []
  let currentTitle = ''
  let currentLines: string[] = []
  let inStep = false
  // Single CommonMark-grammar classification (md-grammar.ts) replaces the old
  // createFenceTracker + commentLineFlags pair. It is the SAME block grammar
  // Goldmark renders with, so an H3 our splitter sees as a delimiter is exactly
  // an H3 Goldmark renders as a heading — no divergence, no phantom steps.
  //   - lines inside a fenced OR indented code block classify as 'code': an H3
  //     quoted there (authoring-syntax demos) is literal content, not a step
  //     (cookbook phantom-step bug).
  //   - lines inside a multi-line `<!-- ... -->` comment classify as 'html':
  //     a commented-out `### ` is neither a delimiter nor stranded across the
  //     split (Devtoberfest validation-tutorial break #2127). html lines are
  //     dropped from step content, mirroring intro.ts.
  const classes = classifyLines(body)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kind = classes[i]?.kind

    if (kind === 'code') {
      if (inStep) currentLines.push(line)
      continue
    }

    if (kind === 'html') continue // commented/raw-HTML lines: non-delimiting, dropped from content

    if (classes[i]?.kind === 'heading' && classes[i].level === 3) {
      if (inStep) {
        steps.push({
          number: steps.length + 1,
          title: currentTitle,
          content: stripMarkers(currentLines).join('\n').trim()
        })
      }
      currentTitle = line.replace(/^###\s+/, '').trim()
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
