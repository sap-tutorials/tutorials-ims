/**
 * Author-note pre-pass: strip or render `%% … %%` author annotations.
 *
 * Inline note:  `prose %% @author: text %% more prose`  — opens and closes on
 *               the same line.
 * Block note:   a line containing only `%%` (trimmed) opens; the next line
 *               containing only `%%` closes. Content between the delimiters is
 *               the note body.
 *
 * Fence-awareness: any line classified as `'code'` by classifyLines() (i.e.
 * inside a fenced or indented code block) is treated as literal — `%%` on such
 * a line is never a delimiter.
 */

import { classifyLines } from './md-grammar.js'

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Thrown on QA channel when an author note is never closed. */
export class AuthorNoteError extends Error {
  /** 1-based line number of the opening `%%` delimiter. */
  line: number

  constructor(message: string, line: number) {
    super(message)
    this.name = 'AuthorNoteError'
    this.line = line
    // Maintain proper prototype chain in transpiled ES5 environments.
    Object.setPrototypeOf(this, AuthorNoteError.prototype)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse attribution prefix out of a note body string.
 * Only the FIRST line is checked for an `@author:` prefix.
 * Remaining lines, if any, are preserved as the note body.
 *
 * `@jdoe: text`       → { author: 'jdoe', body: 'text' }
 * `@jdoe:\nline2`     → { author: 'jdoe', body: 'line2' }
 * `@jdoe: l1\nline2`  → { author: 'jdoe', body: 'l1\nline2' }
 * `text\nline2`       → { author: '',     body: 'text\nline2' }
 */
function parseAttribution(raw: string): { author: string; body: string } {
  const newlineIdx = raw.indexOf('\n')
  const firstLine = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx)
  const rest = newlineIdx === -1 ? '' : raw.slice(newlineIdx + 1)

  const m = firstLine.match(/^@([\w.-]+):\s*(.*)$/)
  if (m) {
    const firstBody = m[2].trim()
    const fullBody = rest ? (firstBody ? `${firstBody}\n${rest}` : rest) : firstBody
    return { author: m[1], body: fullBody }
  }
  return { author: '', body: raw.trim() }
}

/**
 * Build the QA HTML span for an inline author note.
 */
function renderInlineQA(raw: string): string {
  const { author, body } = parseAttribution(raw)
  return `<span class="tut-author-note" data-author="${author}"><span class="tut-author-note-text">${body}</span></span>`
}

/**
 * Build the QA HTML div for a block author note.
 */
function renderBlockQA(raw: string, author: string): string {
  return `<div class="tut-author-note-block" data-author="${author}"><div class="tut-author-note-text">${raw}</div></div>`
}

// Regex for an inline note: %% ... %% on a single line.
// Non-greedy so nested %% pairs on one line are each their own note.
const INLINE_NOTE_RE = /%%([^%]|%(?!%))*%%/g

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Strip or render author notes.
 *
 * @param body    Raw markdown body (may contain author notes).
 * @param channel `'prod'` strips all notes; `'qa'` renders them as HTML.
 * @param slug    Optional tutorial slug for diagnostic messages.
 * @returns       Processed body string.
 * @throws        {AuthorNoteError} on QA when a note is unterminated.
 */
export function stripAuthorNotes(body: string, channel: 'prod' | 'qa', slug?: string): string {
  const lines = body.split('\n')
  const classes = classifyLines(body)

  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const lineNum = i + 1 // 1-based

    // Lines inside a code block are never touched.
    if (classes[i]?.kind === 'code') {
      out.push(line)
      i++
      continue
    }

    // -----------------------------------------------------------------------
    // Block note: a line whose trimmed content is exactly `%%`
    // -----------------------------------------------------------------------
    if (line.trim() === '%%') {
      const openLine = lineNum // 1-based line of the opening %%
      // Collect content lines until the next bare `%%` (outside code).
      const contentLines: string[] = []
      i++ // move past the opening %%

      let closed = false
      while (i < lines.length) {
        if (classes[i]?.kind === 'code') {
          // A code line inside a block note counts as content.
          contentLines.push(lines[i])
          i++
          continue
        }
        if (lines[i].trim() === '%%') {
          // Found the closing delimiter.
          i++ // move past the closing %%
          closed = true
          break
        }
        contentLines.push(lines[i])
        i++
      }

      if (!closed) {
        if (channel === 'qa') {
          throw new AuthorNoteError('Unterminated author note', openLine)
        } else {
          console.warn(
            `[author-notes] unterminated note at line ${openLine}${slug ? ` in ${slug}` : ''} — stripped to end-of-step`
          )
          // Strip to end: emit empty line in place of the whole block.
          out.push('')
          continue
        }
      }

      if (channel === 'prod') {
        // Replace the entire block note with a single empty line so the
        // surrounding lines are separated by exactly one blank line.
        out.push('')
      } else {
        // QA: render as a block div.
        const rawBody = contentLines.join('\n').trim()
        const { author, body: noteBody } = parseAttribution(rawBody)
        out.push(renderBlockQA(noteBody, author))
      }
      continue
    }

    // -----------------------------------------------------------------------
    // Inline notes: %% ... %% on a single line
    // -----------------------------------------------------------------------
    if (line.includes('%%')) {
      // Check if there is any inline note pattern on this line.
      if (INLINE_NOTE_RE.test(line)) {
        INLINE_NOTE_RE.lastIndex = 0 // reset after .test()

        if (channel === 'prod') {
          out.push(line.replace(INLINE_NOTE_RE, ''))
        } else {
          out.push(
            line.replace(INLINE_NOTE_RE, (match) => {
              // Strip the surrounding %% delimiters.
              const inner = match.slice(2, -2).trim()
              return renderInlineQA(inner)
            })
          )
        }
        i++
        continue
      }

      // `%%` present but no closed inline pattern → could be an opening inline
      // that runs to a later line. This is handled as an unterminated note.
      // Find where the opening `%%` is on this line.
      const openPos = line.indexOf('%%')
      if (openPos !== -1) {
        // Unclosed inline note.
        if (channel === 'qa') {
          throw new AuthorNoteError('Unterminated author note', lineNum)
        } else {
          console.warn(
            `[author-notes] unterminated note at line ${lineNum}${slug ? ` in ${slug}` : ''} — stripped to end-of-step`
          )
          // Strip from %% to end-of-line on PROD.
          out.push(line.slice(0, openPos))
          i++
          continue
        }
      }
    }

    out.push(line)
    i++
  }

  let result = out.join('\n')

  if (channel === 'prod') {
    // Collapse runs of 3+ blank lines down to 2 blank lines.
    result = result.replace(/\n{4,}/g, '\n\n\n')
  }

  return result
}
