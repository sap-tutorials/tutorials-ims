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
  label: string
  type: 'string' | 'number'
  maxLength?: number
  required?: boolean
  placeholder?: string
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

    // Validate label
    const label = raw['label']
    if (typeof label !== 'string' || !label) {
      throw new VariablesValidationError(
        `tutorial variables "${name}": missing required field "label"`
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
      label,
      type: type as 'string' | 'number',
    }
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
 *  - **Outside** fenced code (prose + inline code):
 *    `<span class="tut-var" data-tut-var="NAME">PLACEHOLDER</span>`
 *    where PLACEHOLDER is the declared `placeholder` (HTML-escaped) or empty.
 *
 *  - **Inside** fenced code (code blocks):
 *    `TUTVARxNAMEx` — a letters-only sentinel that is lexer-opaque in all
 *    Chroma-highlighted languages, including bash. Does NOT emit a span.
 *
 * Uses `createFenceTracker()` line-by-line to distinguish prose/inline from
 * fenced blocks, matching CommonMark semantics.
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
      // Outside a fenced block (prose or inline code):
      // replace every {{var:NAME}} with a tut-var span
      const replaced = line.replace(TOKEN_RE, (_match, name: string) => {
        const placeholder = placeholderFor.get(name) ?? ''
        return `<span class="tut-var" data-tut-var="${name}">${placeholder}</span>`
      })
      out.push(replaced)
    }
  }

  return out.join('\n')
}
