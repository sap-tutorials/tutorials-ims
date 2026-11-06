/**
 * Tutorial Variables — source frontmatter schema, validation, and token wrapping.
 *
 * Authors declare `variables:` in source frontmatter:
 *
 *   variables:
 *     - name: groupNumber
 *       label: Your BTP Trial Group Number
 *       type: string
 *       maxLength: 6
 *       placeholder: XXX
 *
 * And reference them in the body with `{{var:NAME}}` tokens.
 *
 * [#2852] Two optional fields let an author fix a value once and/or hide it:
 *   - `value: <string>`  — author-fixed literal, substituted everywhere;
 *                          overrides a regex `default`.
 *   - `display: <bool>`  — show the reader-facing input. Absent/`true` = shown
 *                          (the default); `false` = hidden (no label needed,
 *                          value still substitutes into the body).
 * Precedence for the substituted value (resolved client-side): `value` >
 * `default` (regex) > reader input > empty.
 *
 * This module:
 *  - Validates the declared block (throws VariablesValidationError on malformed input)
 *  - Wraps tokens for prose/inline code as HTML spans
 *  - Replaces tokens inside fenced code blocks with a letters-only sentinel
 *    (Chroma fragments `{{` in operator-lexing languages like bash)
 *
 * Spike result: sentinel form `TUTVARxNAMEx` is lexer-opaque across all tested
 * language lexers. Round-trips to NAME in Task 3.
 */

import { createFenceTracker } from './fence-tracker.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TutorialVariable {
  name: string
  /**
   * Human-readable label for the reader-facing input. Required when the
   * variable is displayed; optional (and unused) when `display: false`.
   */
  label?: string
  type: 'string' | 'number'
  maxLength?: number
  required?: boolean
  placeholder?: string
  /**
   * [#2852] Author-fixed literal value. When set, this is the substituted
   * value and overrides any regex `default`. For a hidden variable
   * (`display: false`) the author uses this to set a value once that
   * substitutes everywhere without showing an input to the reader.
   */
  value?: string
  /**
   * [#2852] Whether to show an input for this variable in the reader-facing
   * "Your values" panel. Absent or `true` → shown (the default). `false` →
   * hidden; the value still substitutes into the tutorial body.
   */
  display?: boolean
  default?: {
    from: 'email' | 'id' | 'givenName' | 'familyName'
    pattern: string
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class VariablesValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VariablesValidationError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowlist for `default.from` values. */
const FROM_ALLOWLIST = new Set<string>(['email', 'id', 'givenName', 'familyName'])

/** Valid `type` values. */
const TYPE_ALLOWLIST = new Set<string>(['string', 'number'])

/**
 * NAME must start with a letter and contain only letters, digits, underscores.
 * Letters-only + underscore so the sentinel `TUTVARxNAMEx` stays lexer-opaque.
 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/** Token pattern in source/prose: `{{var:NAME}}` */
const TOKEN_RE = /\{\{var:([A-Za-z][A-Za-z0-9_]*)\}\}/g

/**
 * Sentinel pattern for tokens INSIDE fenced code blocks.
 * `TUTVARxNAMEx` — letters and underscore only, lexer-opaque in bash and all
 * other Chroma-highlighted languages. Must round-trip to NAME in Task 3.
 * Exported so Task 3 and tests share the exact shape.
 */
export const SENTINEL_RE = /TUTVARx([A-Za-z0-9_]+)x/g

/**
 * Returns the sentinel string for a given variable NAME.
 */
export function sentinelFor(name: string): string {
  return `TUTVARx${name}x`
}

// ---------------------------------------------------------------------------
// validateVariables
// ---------------------------------------------------------------------------

/**
 * Validates a raw `variables:` frontmatter block.
 *
 * Throws `VariablesValidationError` (naming the offending variable) on:
 *  - `vars` is not an array
 *  - missing or invalid `name` (must match NAME_RE)
 *  - duplicate `name`
 *  - `type` not in {string, number}
 *  - `default.from` off the allowlist {email, id, givenName, familyName}
 *  - `default.pattern` that does not compile as a RegExp
 *  - a `{{var:X}}` token in `body` whose `X` is not declared
 *
 * A *declared-but-unused* variable is allowed (soft — no throw).
 *
 * @param vars  The raw `variables:` frontmatter value (unknown — may be any shape)
 * @param body  The combined tutorial body text (pre-split steps or full body);
 *              used to find undeclared token references.
 * @returns     A validated array of TutorialVariable objects
 */
export function validateVariables(vars: unknown, body: string): TutorialVariable[] {
  if (!Array.isArray(vars)) {
    throw new VariablesValidationError(
      `tutorial variables: expected an array but got ${typeof vars}`
    )
  }

  const seen = new Set<string>()
  const result: TutorialVariable[] = []

  for (const entry of vars) {
    if (typeof entry !== 'object' || entry === null) {
      throw new VariablesValidationError(
        `tutorial variables: each entry must be an object, got ${typeof entry}`
      )
    }

    const raw = entry as Record<string, unknown>

    // Validate name
    const name = raw['name']
    if (typeof name !== 'string' || !name) {
      throw new VariablesValidationError(
        `tutorial variables: entry is missing required field "name"`
      )
    }
    if (!NAME_RE.test(name)) {
      throw new VariablesValidationError(
        `tutorial variables "${name}": name must match [A-Za-z][A-Za-z0-9_]* (got "${name}")`
      )
    }
    if (seen.has(name)) {
      throw new VariablesValidationError(
        `tutorial variables "${name}": duplicate variable name`
      )
    }
    seen.add(name)

    // Validate display (optional). [#2852] Must be a real boolean when present.
    // Absent → shown (default). `false` → hidden from the reader-facing panel.
    const display = raw['display']
    if (display !== undefined && typeof display !== 'boolean') {
      throw new VariablesValidationError(
        `tutorial variables "${name}": display must be a boolean (got "${typeof display}")`
      )
    }
    const isHidden = display === false

    // Validate label. Required for a displayed variable; a hidden variable
    // (display:false) needs no label because no input is rendered for it.
    const label = raw['label']
    if (!isHidden && (typeof label !== 'string' || !label)) {
      throw new VariablesValidationError(
        `tutorial variables "${name}": missing required field "label"`
      )
    }
    if (label !== undefined && typeof label !== 'string') {
      throw new VariablesValidationError(
        `tutorial variables "${name}": label must be a string`
      )
    }

    // Validate value (optional). [#2852] Author-fixed literal; must be a string.
    const value = raw['value']
    if (value !== undefined && typeof value !== 'string') {
      throw new VariablesValidationError(
        `tutorial variables "${name}": value must be a string (got "${typeof value}")`
      )
    }

    // Validate type
    const type = raw['type']
    if (!TYPE_ALLOWLIST.has(type as string)) {
      throw new VariablesValidationError(
        `tutorial variables "${name}": type must be "string" or "number" (got "${type}")`
      )
    }

    // Validate default (optional)
    const def = raw['default']
    if (def !== undefined && def !== null) {
      if (typeof def !== 'object' || Array.isArray(def)) {
        throw new VariablesValidationError(
          `tutorial variables "${name}": default must be an object with "from" and "pattern"`
        )
      }
      const defObj = def as Record<string, unknown>
      const from = defObj['from']
      if (!FROM_ALLOWLIST.has(from as string)) {
        throw new VariablesValidationError(
          `tutorial variables "${name}": default.from must be one of ${[...FROM_ALLOWLIST].join(', ')} (got "${from}")`
        )
      }
      const pattern = defObj['pattern']
      if (typeof pattern !== 'string') {
        throw new VariablesValidationError(
          `tutorial variables "${name}": default.pattern must be a string`
        )
      }
      try {
        new RegExp(pattern)
      } catch {
        throw new VariablesValidationError(
          `tutorial variables "${name}": default.pattern "${pattern}" is not a valid regular expression`
        )
      }
    }

    // Build validated object
    const validated: TutorialVariable = {
      name,
      type: type as 'string' | 'number',
    }
    if (typeof label === 'string') validated.label = label
    if (typeof value === 'string') validated.value = value
    if (typeof display === 'boolean') validated.display = display
    if (typeof raw['maxLength'] === 'number') validated.maxLength = raw['maxLength']
    if (typeof raw['required'] === 'boolean') validated.required = raw['required']
    if (typeof raw['placeholder'] === 'string') validated.placeholder = raw['placeholder']
    if (def !== undefined && def !== null) {
      const defObj = def as Record<string, unknown>
      validated.default = {
        from: defObj['from'] as TutorialVariable['default']['from'],
        pattern: defObj['pattern'] as string,
      }
    }

    result.push(validated)
  }

  // Check for undeclared tokens in body. Walk lines through fence tracker so
  // sentinels (which don't exist yet) don't interfere — we're checking the
  // raw source body, which still has `{{var:X}}` tokens.
  const declaredNames = new Set(result.map(v => v.name))
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(body)) !== null) {
    const tokenName = m[1]
    if (!declaredNames.has(tokenName)) {
      throw new VariablesValidationError(
        `tutorial variables: body references undeclared variable "{{var:${tokenName}}}"`
      )
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// HTML escaping helper
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// wrapTokens
// ---------------------------------------------------------------------------

/**
 * Replaces `{{var:NAME}}` tokens in `markdown` depending on context:
 *
 *  - **Inside fenced code blocks**: `TUTVARxNAMEx` — a letters-only sentinel
 *    that is lexer-opaque in all Chroma-highlighted languages, including bash.
 *    Does NOT emit a span. (Handled by the Hugo fenced-code render hook.)
 *
 *  - **Inside inline-code spans** (backtick runs on a non-fenced line):
 *    `TUTVARxNAMEx` — also a sentinel. Goldmark HTML-escapes the content of
 *    `<code>` elements, so a raw `<span>` injected here would render as escaped
 *    literal text and NEVER become a real DOM element. The client-side
 *    `expandSentinels()` helper in the island converts these at mount time.
 *
 *  - **Prose** (everything else): `<span class="tut-var" data-tut-var="NAME">
 *    PLACEHOLDER</span>` — a real HTML element that Hugo passes through.
 *
 * Uses `createFenceTracker()` line-by-line to detect fenced blocks.
 * Within non-fenced lines, a CommonMark inline-code-span tracker detects
 * backtick runs so tokens inside them become sentinels instead of spans.
 *
 * @param markdown  The markdown string to transform (typically a step's content)
 * @param vars      Validated TutorialVariable array from validateVariables()
 * @returns         The transformed markdown string
 */
export function wrapTokens(markdown: string, vars: TutorialVariable[]): string {
  if (vars.length === 0) return markdown

  // Build a lookup map from name → placeholder (HTML-escaped or empty)
  const placeholderFor = new Map<string, string>()
  for (const v of vars) {
    placeholderFor.set(v.name, v.placeholder ? escapeHtml(v.placeholder) : '')
  }

  const fence = createFenceTracker()
  const lines = markdown.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const inFence = fence(line)

    if (inFence) {
      // Inside a fenced code block: replace every {{var:NAME}} with sentinel
      const replaced = line.replace(TOKEN_RE, (_match, name: string) => {
        return sentinelFor(name)
      })
      out.push(replaced)
    } else {
      // Outside a fenced block: walk the line character-by-character, tracking
      // inline-code spans (CommonMark: a run of N backticks opens a code span
      // closed by the next run of exactly N backticks). Tokens inside an open
      // inline-code span become sentinels; tokens in prose become spans.
      out.push(wrapNonFencedLine(line, placeholderFor))
    }
  }

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// PlaceholderDef — fill-in placeholder token type
// ---------------------------------------------------------------------------

/**
 * A placeholder token declared via `placeholders:` frontmatter.
 * In `auto` mode, tokens are detected by the regex below.
 * In explicit mode, authors declare them in frontmatter.
 */
export interface PlaceholderDef {
  token: string
  label: string
}

/**
 * Regex matching placeholder tokens in `auto` mode.
 * Matches: <YOUR_SOMETHING>, <MY-something>, <BTP_TRIAL> (3+ uppercase chars)
 * Does NOT match: <String>, <div>, <T>, <AB>, generics, HTML tags.
 */
const PLACEHOLDER_RE = /(?<![A-Za-z])<(?:YOUR[-_]|MY[-_])[A-Za-z0-9_-]+>|<[A-Z][A-Z0-9_]{2,}>/g

/**
 * Humanise a placeholder token into a label.
 * <YOUR_SUBACCOUNT> → "Your Subaccount"
 * <MY-space-name> → "My Space Name"
 * <BTP_TRIAL> → "Btp Trial"
 */
function humaniseToken(token: string): string {
  const inner = token.replace(/^<|>$/g, '')
  return inner
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Derive a NAME_RE-safe variable name from a placeholder token.
 * <YOUR_SUBACCOUNT> → YOUR_SUBACCOUNT
 * <MY-space-name> → MY_space_name
 */
function tokenToName(token: string): string {
  return token.replace(/^<|>$/g, '').replace(/-/g, '_')
}

/**
 * Validate a `placeholders:` frontmatter value.
 *
 * @param raw   The raw `placeholders:` value: the string `"auto"` or an array
 *              of `{ token, label? }` objects.
 * @param body  The tutorial body; used for auto-detection.
 * @returns     Array of PlaceholderDef objects (deduplicated).
 */
export function validatePlaceholders(raw: unknown, body: string): PlaceholderDef[] {
  if (raw === 'auto') {
    // Scan the body for placeholder-shaped tokens
    const seen = new Set<string>()
    const result: PlaceholderDef[] = []
    PLACEHOLDER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PLACEHOLDER_RE.exec(body)) !== null) {
      const token = m[0]
      if (!seen.has(token)) {
        seen.add(token)
        result.push({ token, label: humaniseToken(token) })
      }
    }
    return result
  }

  if (!Array.isArray(raw)) {
    throw new VariablesValidationError(
      `tutorial placeholders: expected "auto" or an array of {token, label?} objects`
    )
  }

  const seen = new Set<string>()
  const result: PlaceholderDef[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>)['token'] !== 'string') {
      throw new VariablesValidationError(
        `tutorial placeholders: each entry must have a "token" string field`
      )
    }
    const token = (entry as Record<string, unknown>)['token'] as string
    const labelRaw = (entry as Record<string, unknown>)['label']
    const label = typeof labelRaw === 'string' ? labelRaw : humaniseToken(token)
    if (!seen.has(token)) {
      seen.add(token)
      result.push({ token, label })
    }
  }
  return result
}

/**
 * Convert each placeholder token in `markdown` to the existing variable sentinel,
 * so the `tut-var` island picks it up automatically.
 *
 * Inside fenced code: `TUTVARxNAMEx`
 * In prose: `<span class="tut-var tut-placeholder" data-tut-var="NAME">TOKEN</span>`
 *
 * Reuses `wrapTokens` internally by converting tokens to `{{var:NAME}}` form
 * and then delegating fence/prose distinction to wrapTokens.
 */
export function wrapPlaceholders(markdown: string, placeholders: PlaceholderDef[]): string {
  if (placeholders.length === 0) return markdown

  // Build synthetic TutorialVariable entries
  const synthVars: TutorialVariable[] = placeholders.map((p) => ({
    name: tokenToName(p.token),
    label: p.label,
    type: 'string' as const,
    placeholder: p.token,
    display: true,
  }))

  // Replace the exact token text with `{{var:NAME}}` syntax, then call wrapTokens.
  // This is the cleanest approach: we convert tokens to the existing {{var:X}} form
  // and then let wrapTokens handle the fence/prose distinction.
  let transformed = markdown
  for (const p of placeholders) {
    const name = tokenToName(p.token)
    // Escape regex special chars in token (angle brackets, hyphens etc.)
    const escaped = p.token.replace(/[<>[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
    transformed = transformed.replace(new RegExp(escaped, 'g'), `{{var:${name}}}`)
  }

  return wrapTokens(transformed, synthVars)
}

// ---------------------------------------------------------------------------

/**
 * Processes a single non-fenced line, replacing {{var:NAME}} tokens:
 *  - inside an open backtick run (inline-code span) → sentinel
 *  - in prose → <span class="tut-var" ...>
 *
 * Implements CommonMark inline-code detection: a run of N backticks opens
 * a code span, closed by the NEXT run of exactly N backticks. Nested or
 * mismatched runs are left as-is (standard CommonMark fallback).
 */
function wrapNonFencedLine(line: string, placeholderFor: Map<string, string>): string {
  // Fast path: if the line has no token at all, skip processing entirely.
  TOKEN_RE.lastIndex = 0
  if (!TOKEN_RE.test(line)) return line

  // Two-pass approach:
  //   Pass 1: parse inline-code span boundaries using CommonMark backtick rules.
  //   Pass 2: replace tokens, using the boundary map to decide sentinel vs span.

  // Pass 1: collect all inline-code span [start, end) byte ranges on this line.
  // Uses the CommonMark algorithm: scan for backtick runs; when a run is found
  // that closes a previously-opened run of the same length, record the span.
  const inCodeRanges: Array<[number, number]> = []

  let i = 0
  const len = line.length
  // pendingOpeners: map from backtick-run-length → position of the opening run's first backtick.
  // We only track the FIRST opener per length (CommonMark: leftmost wins).
  const pendingOpeners = new Map<number, number>()

  while (i < len) {
    if (line[i] !== '`') {
      i++
      continue
    }
    // Count the backtick run
    const runStart = i
    while (i < len && line[i] === '`') i++
    const runLen = i - runStart

    if (pendingOpeners.has(runLen)) {
      // This run closes the pending opener of the same length
      const openStart = pendingOpeners.get(runLen)!
      const closeEnd = i
      // The CODE SPAN content is (openStart + runLen) … (closeEnd - runLen)
      // but for our purposes we need the FULL span including backticks,
      // because token positions reference the raw line.
      inCodeRanges.push([openStart, closeEnd])
      pendingOpeners.delete(runLen)
    } else {
      // New potential opener — only record if not already tracking this length
      pendingOpeners.set(runLen, runStart)
    }
  }

  if (inCodeRanges.length === 0) {
    // No inline-code spans found — all tokens are in prose
    TOKEN_RE.lastIndex = 0
    return line.replace(TOKEN_RE, (_match, name: string) => {
      const placeholder = placeholderFor.get(name) ?? ''
      return `<span class="tut-var" data-tut-var="${name}">${placeholder}</span>`
    })
  }

  // Pass 2: replace tokens with context-awareness
  TOKEN_RE.lastIndex = 0
  return line.replace(TOKEN_RE, (match, name: string, offset: number) => {
    // Check whether this token starts inside any inline-code span range
    const isInCode = inCodeRanges.some(([start, end]) => offset >= start && offset < end)
    if (isInCode) {
      return sentinelFor(name)
    }
    const placeholder = placeholderFor.get(name) ?? ''
    return `<span class="tut-var" data-tut-var="${name}">${placeholder}</span>`
  })
}
