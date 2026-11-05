// [tutorial-step-pacing] Shared heading-attribute parsing for v2 step
// headings: `### Deploy the app {time=5m optional}`.
//
// Design (openspec/changes/tutorial-step-pacing/design.md, D1):
//   - Match a trailing `\s*\{([^}]*)\}\s*$` on the step heading text ONLY
//     (never on the tutorial H1 or intro `##` headings).
//   - Recognised tokens: `time=<duration>` and `optional`.
//   - The attribute block is stripped from the title BEFORE slug computation
//     so `### Deploy {time=5m}` and `### Deploy` produce the same slug —
//     existing progress, deep links and osOverrides keys are unaffected.
//   - If ANY token in the braces is unrecognised, the WHOLE brace block is
//     left attached to the title (so `### Return {status: ok}` keeps its
//     literal `{status: ok}`) and a `step-attr/unknown` warning is reported.
//   - An invalid `time=` duration is a hard build failure naming the step.
//
// Used by scripts/parsers/v2.ts (title/slug + timeSeconds/optional on the
// parsed TutorialStep) and scripts/parsers/options.ts (`priorStepSlug`, so
// an OPTION block's osOverrides lookup resolves the SAME slug v2.ts computes
// for the owning step).

const HEADING_ATTRS_RE = /^(.*?)\s*\{([^}]*)\}\s*$/
const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/
const MAX_SECONDS = 8 * 3600

export class StepAttrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepAttrError'
  }
}

export interface StepHeadingAttrs {
  /** Step title with any recognised `{…}` attribute block removed. */
  title: string
  timeSeconds?: number
  optional?: boolean
  /** `step-attr/unknown`-prefixed lint warnings, empty when nothing to report. */
  warnings: string[]
}

/** Parse a `time=<duration>` value into whole seconds. Grammar:
 *  `(\d+h)?(\d+m)?(\d+s)?`, non-empty, max 8h. Throws StepAttrError on
 *  anything else (unexpected characters, zero/negative, or >8h). */
function parseDuration(raw: string, stepTitle: string): number {
  const m = raw.match(DURATION_RE)
  if (!m || (!m[1] && !m[2] && !m[3])) {
    throw new StepAttrError(`invalid step time "${raw}" in step "${stepTitle}" — expected a duration like "5m", "90s" or "1h30m"`)
  }
  const hours = parseInt(m[1] || '0', 10)
  const minutes = parseInt(m[2] || '0', 10)
  const seconds = parseInt(m[3] || '0', 10)
  const total = hours * 3600 + minutes * 60 + seconds
  if (total <= 0 || total > MAX_SECONDS) {
    throw new StepAttrError(`invalid step time "${raw}" in step "${stepTitle}" — must be greater than 0 and at most 8h`)
  }
  return total
}

/**
 * Extract and validate a trailing heading-attribute block from a step title.
 * `rawTitle` is the heading text with the leading `### ` already stripped.
 */
export function parseStepHeadingAttrs(rawTitle: string): StepHeadingAttrs {
  const match = rawTitle.match(HEADING_ATTRS_RE)
  if (!match) return { title: rawTitle.trim(), warnings: [] }

  const [, base, inner] = match
  const baseTitle = base.trim()
  const tokens = inner.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { title: baseTitle, warnings: [] }

  const unknown: string[] = []
  let timeSeconds: number | undefined
  let optional = false

  for (const token of tokens) {
    if (token === 'optional') {
      optional = true
      continue
    }
    const timeMatch = token.match(/^time=(.+)$/)
    if (timeMatch) {
      timeSeconds = parseDuration(timeMatch[1], baseTitle)
      continue
    }
    unknown.push(token)
  }

  if (unknown.length > 0) {
    // Any unrecognised token → leave the ENTIRE brace block in the title
    // (D1: "only recognised when every token is a known key…").
    return {
      title: rawTitle.trim(),
      warnings: [
        `step-attr/unknown: step "${baseTitle}" has unrecognised heading attribute(s): {${inner.trim()}}`,
      ],
    }
  }

  return { title: baseTitle, timeSeconds, optional: optional || undefined, warnings: [] }
}
