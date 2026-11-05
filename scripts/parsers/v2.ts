import type { TutorialStep } from './types.js'
import { classifyLines } from './md-grammar.js'
import { parseStepHeadingAttrs } from './step-attrs.js'

const VALIDATE_LINE = /^\s*\[VALIDATE_\d+\]\s*$/
const DONE_LINE = /^\s*\[DONE\]\s*$/

/**
 * @param warningsOut Optional out-param (same pattern as options.ts's
 *   `resolvedStepSlugsOut`): function pushes `step-attr/unknown` lint
 *   warnings here. Caller MUST initialize to a fresh array if it wants them.
 */
export function parseV2Steps(body: string, warningsOut?: string[]): TutorialStep[] {
  const lines = body.split('\n')
  const steps: TutorialStep[] = []
  let currentTitle = ''
  let currentTimeSeconds: number | undefined
  let currentOptional: boolean | undefined
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
          content: stripMarkers(currentLines).join('\n').trim(),
          ...(currentTimeSeconds !== undefined ? { timeSeconds: currentTimeSeconds } : {}),
          ...(currentOptional ? { optional: true } : {}),
        })
      }
      // [tutorial-step-pacing] Strip + validate a trailing `{…}` heading
      // attribute block BEFORE title/slug computation (D1) — this is what
      // keeps `### Deploy` and `### Deploy {time=5m optional}` slug-stable.
      const rawTitle = line.replace(/^###\s+/, '').trim()
      const attrs = parseStepHeadingAttrs(rawTitle)
      currentTitle = attrs.title
      currentTimeSeconds = attrs.timeSeconds
      currentOptional = attrs.optional
      if (warningsOut) warningsOut.push(...attrs.warnings)
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
      content: stripMarkers(currentLines).join('\n').trim(),
      ...(currentTimeSeconds !== undefined ? { timeSeconds: currentTimeSeconds } : {}),
      ...(currentOptional ? { optional: true } : {}),
    })
  }

  return steps
}

function stripMarkers(lines: string[]): string[] {
  return lines.filter(l => !VALIDATE_LINE.test(l) && !DONE_LINE.test(l))
}
