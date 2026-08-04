import { createFenceTracker } from './fence-tracker.js'

const V1_STEP = /\[ACCORDION-BEGIN \[Step \d+:\s*\]\(.+?\)\]/

/**
 * Extract the content that sits before the first tutorial step, minus the
 * blocks already lifted into frontmatter (# Title, <!-- description -->,
 * ## You will learn, ## Prerequisites). Everything else — notably a
 * `## Video Version` section with a raw <iframe> — is preserved verbatim so
 * the Hugo build can render it above the steps. Root cause of the dropped-
 * video bug: parseV2Steps only collects content AFTER the first `### `.
 */
export function extractIntro(body: string, isV2: boolean): string {
  const lines = body.split('\n')
  const fence = createFenceTracker()

  // 1. Find the first step-delimiter line index (fence-aware).
  let firstStep = lines.length
  for (let i = 0; i < lines.length; i++) {
    const inFence = fence(lines[i])
    if (inFence) continue
    if (isV2 ? /^### /.test(lines[i]) : V1_STEP.test(lines[i])) { firstStep = i; break }
  }

  const pre = lines.slice(0, firstStep)

  // 2. Remove recognized blocks. A "section" runs from its `## Heading` up to
  //    the next `## `/`### ` heading (or end of pre-step region).
  const out: string[] = []
  let skipSectionUntilHeading = false
  for (let i = 0; i < pre.length; i++) {
    const line = pre[i]
    const isHeading = /^#{2,3} /.test(line)
    if (skipSectionUntilHeading) {
      if (isHeading) skipSectionUntilHeading = false
      else continue
    }
    if (/^# /.test(line)) continue                        // H1 title
    if (/<!--\s*description\s*-->/.test(line)) continue    // description marker line
    if (/^## (You will learn|Prerequisites)\s*$/.test(line)) {
      skipSectionUntilHeading = true
      continue
    }
    out.push(line)
  }

  return out.join('\n').trim()
}
