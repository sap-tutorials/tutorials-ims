import { createFenceTracker } from './fence-tracker.js'
import { commentLineFlags } from './html-comment-lines.js'

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

  // Flag lines inside multi-line HTML comments (fence-aware). A commented-out
  // `## You will learn` / `## Prerequisites` must NOT be treated as a section
  // heading here — otherwise its opening `<!--` is stranded into the intro as
  // an unterminated comment that swallows every following step at render time
  // (root cause of the codejam-events-process-1-bah break). Such lines are
  // pushed verbatim so the comment stays balanced and renders invisibly.
  const commented = commentLineFlags(pre)

  // 2. Remove recognized blocks. A "section" runs from its `## Heading` up to
  //    the next `## `/`### ` heading (or end of pre-step region).
  const out: string[] = []
  let skipSectionUntilHeading = false
  for (let i = 0; i < pre.length; i++) {
    const line = pre[i]
    // Drop lines inside a multi-line HTML comment entirely — the author
    // disabled that block, so it belongs in neither the intro nor a lifted
    // section. Dropping the whole (balanced) block also guarantees no stranded
    // `<!--`/`-->` survives into the intro.
    if (commented[i]) continue
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
