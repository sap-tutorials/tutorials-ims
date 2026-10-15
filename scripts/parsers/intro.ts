import { classifyLines } from './md-grammar.js'

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
  // One CommonMark-grammar classification (md-grammar.ts) does the work the old
  // createFenceTracker + commentLineFlags pair did: 'code'/'html' lines are
  // non-delimiting (and HTML covers multi-line `<!-- ... -->` comments), while
  // 'heading' marks real section boundaries. Same grammar Goldmark renders.
  const classes = classifyLines(body)

  // 1. Find the first step-delimiter line index (grammar-aware).
  let firstStep = lines.length
  for (let i = 0; i < lines.length; i++) {
    const kind = classes[i]?.kind
    if (kind === 'code' || kind === 'html') continue
    if (isV2 ? classes[i]?.kind === 'heading' && classes[i].level === 3 : V1_STEP.test(lines[i])) { firstStep = i; break }
  }

  const pre = lines.slice(0, firstStep)

  // 2. Remove recognized blocks. A "section" runs from its `## Heading` up to
  //    the next `## `/`### ` heading (or end of pre-step region). A commented-
  //    out `## You will learn` / `## Prerequisites` classifies as 'html' and is
  //    dropped entirely (never treated as a section heading, never stranded as
  //    an unterminated comment that swallows the following steps — root cause of
  //    the codejam-events-process-1-bah break).
  const out: string[] = []
  let skipSectionUntilHeading = false
  let inHtmlComment = false
  for (let i = 0; i < pre.length; i++) {
    const line = pre[i]
    const kind = classes[i]?.kind
    // Drop lines inside an HTML *comment* only (the author disabled that block)
    // — but preserve raw HTML blocks such as a `## Video Version` <iframe>, which
    // the grammar also classifies as 'html' (html_block). Track the comment span
    // across the html-classified lines by its `<!-- … -->` delimiters so a
    // commented-out `## You will learn` is dropped while the video iframe stays.
    if (kind === 'html') {
      const opensComment = /<!--/.test(line)
      const closesComment = /-->/.test(line)
      if (inHtmlComment) {
        if (closesComment) inHtmlComment = false
        continue
      }
      if (opensComment) {
        if (!closesComment) inHtmlComment = true // multi-line comment: keep skipping
        continue
      }
      // Raw (non-comment) HTML block — preserve verbatim (e.g. the video iframe).
      out.push(line)
      continue
    }
    const isHeading = kind === 'heading' && (classes[i].level === 2 || classes[i].level === 3)
    if (skipSectionUntilHeading) {
      if (isHeading) skipSectionUntilHeading = false
      else continue
    }
    if (classes[i]?.kind === 'heading' && classes[i].level === 1) continue   // H1 title
    if (/<!--\s*description\s*-->/.test(line)) continue                        // inline description marker
    if (/^## (You will learn|Prerequisites)\s*$/.test(line)) {
      skipSectionUntilHeading = true
      continue
    }
    out.push(line)
  }

  return out.join('\n').trim()
}
