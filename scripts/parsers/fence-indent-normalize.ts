/**
 * fence-indent-normalize — CommonMark-correct fenced-code-block indentation fixer.
 *
 * ## Why this exists
 *
 * A subset of legacy SAP tutorial sources (migrated from AEM) contain fenced
 * code blocks whose opening fence, body, and closing fence do NOT share a
 * consistent indentation. The classic shape is:
 *
 *     1. Run this statement:
 *
 *        ```SQL              <- opening fence indented 3 spaces (list-content column)
 *     SELECT ...             <- body dedented to column 0
 *     ```                    <- closing fence at column 0  (or sometimes 3)
 *
 * ## Why that breaks under CommonMark / Goldmark (Hugo)
 *
 * Per the CommonMark spec (§4.5 "Fenced code blocks"):
 *   - An opening fence may be indented 0-3 spaces. When it sits at column 3
 *     immediately after an ordered-list item marker (`N. ` => content column 3)
 *     Goldmark attaches the fence to the *list item* rather than treating it as
 *     a top-level block.
 *   - The content of a fenced block has up to N leading spaces removed, where N
 *     is the opening fence's indentation, but a body line LESS indented than the
 *     opener (here, column 0 vs the list's column-3 context) is still consumed
 *     as code.
 *   - A closing fence must (a) use the same fence char, (b) be at least as long
 *     as the opener, and (c) be indented 0-3 spaces *in the same block context*.
 *     When the opener was absorbed into a list item but the closer appears at
 *     column 0, Goldmark does not recognise the column-0 line as the matching
 *     closer for the list-nested opener — the fence then runs to EOF (or to the
 *     next fence that happens to re-sync), swallowing every following `### `
 *     section heading into one giant `<pre><code>` and collapsing the tutorial
 *     to a single step.
 *
 * ## The fix (conservative, universal, verified empirically)
 *
 * For each fenced code block (paired in document order exactly as CommonMark
 * pairs them), re-anchor the OPENING fence, the CLOSING fence, AND every body
 * line to a single consistent base column:
 *
 *     base = clamp(min(openerIndent, closerIndent, bodyMinIndent), 0, 3)
 *
 * - Opener and closer are rewritten to `base` spaces of indent (so they always
 *   agree and are a legal 0-3 top-level fence pair).
 * - Body lines keep their RELATIVE indentation: we shift every body line by the
 *   same delta so none drops below `base`. In practice these sources dedent the
 *   body to column 0, so `base` resolves to 0 and the block becomes a clean
 *   top-level fenced block — which is exactly how Goldmark then renders it,
 *   terminating at the (now column-0) closer and releasing the trailing headings.
 *
 * This is deliberately NOT a "clever shifter": it never *increases* indentation
 * beyond what the content already uses, never changes fence length or info
 * string, and never touches anything outside a recognised open/close pair. A
 * fence that is already consistent (opener, body, closer all share a column in
 * 0-3) is left byte-for-byte unchanged.
 *
 * ## Scope / non-goals
 *
 * - Only ``` and ~~~ fenced blocks are handled; indented (4-space) code blocks
 *   are intentionally ignored.
 * - Fences appearing inside blockquotes (`>` prefixed) are left to the dedicated
 *   blockquote-fence healer and skipped here.
 * - This is a SOURCE fixer (run by scan-markdown-source / author lint), not a
 *   runtime build heal. It replaces the buggy #2720 `normalizeListFenceColumnZero`.
 */

const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/;

interface FenceLine {
  index: number;
  indent: number;
  char: '`' | '~';
  runLength: number;
  info: string;
}

function parseFence(line: string): FenceLine | null {
  const m = line.match(FENCE_RE);
  if (!m) return null;
  // Skip blockquote-contained fences — not our job.
  if (/^\s*>/.test(line)) return null;
  const indent = m[1].length;
  // Opening fences may be indented at most 3 spaces to count as a fence under
  // CommonMark; a 4+-space line is an indented code block, not a fence opener.
  // We still parse it here for closer-matching, but opener detection re-checks.
  return {
    index: -1,
    indent,
    char: m[2][0] as '`' | '~',
    runLength: m[2].length,
    info: m[3],
  };
}

function leadingSpaces(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/**
 * Normalize fenced-code-block indentation so every opener/closer pair shares a
 * consistent base column (0-3) that keeps the body inside the block. See file
 * header for the full CommonMark rationale.
 *
 * @param markdown Full markdown body (frontmatter may be present — it contains
 *                 no fences, so it passes through untouched).
 * @returns The normalized markdown with LF line endings preserved.
 */
export function normalizeFenceIndent(markdown: string): string {
  const lines = markdown.split('\n');
  const out = lines.slice();

  let i = 0;
  while (i < lines.length) {
    const openFence = parseFence(lines[i]);
    // A valid OPENING fence must be indented 0-3 spaces.
    if (!openFence || openFence.indent > 3) {
      i++;
      continue;
    }

    // Find the matching closing fence in document order: same fence char, run
    // length >= opener, indent 0-3, info string empty (CommonMark requires a
    // closing fence to carry no info string).
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const f = parseFence(lines[j]);
      if (
        f &&
        f.char === openFence.char &&
        f.runLength >= openFence.runLength &&
        f.indent <= 3 &&
        f.info.trim() === ''
      ) {
        close = j;
        break;
      }
    }

    if (close === -1) {
      // No closer found — leave as-is and move on (do not invent a closer).
      i++;
      continue;
    }

    const closeFence = parseFence(lines[close])!;

    // Compute the minimum indentation of the body (non-blank lines only).
    let bodyMin = Infinity;
    for (let j = i + 1; j < close; j++) {
      if (lines[j].trim() === '') continue; // blank lines carry no indent info
      bodyMin = Math.min(bodyMin, leadingSpaces(lines[j]));
    }
    if (!isFinite(bodyMin)) bodyMin = openFence.indent; // empty body

    // Base column: the shallowest of opener / closer / body, clamped to 0-3 so
    // the fences stay legal top-level fences.
    const base = Math.max(0, Math.min(3, openFence.indent, closeFence.indent, bodyMin));

    // Fast path: already consistent — leave the block byte-for-byte unchanged.
    const alreadyConsistent =
      openFence.indent === base &&
      closeFence.indent === base &&
      bodyMin >= base;
    if (alreadyConsistent) {
      i = close + 1;
      continue;
    }

    // Rewrite opener and closer to `base` spaces, preserving fence run + info.
    const pad = ' '.repeat(base);
    out[i] = pad + openFence.char.repeat(openFence.runLength) + openFence.info;
    out[close] = pad + closeFence.char.repeat(closeFence.runLength);

    // Shift body lines so the shallowest non-blank body line lands at `base`,
    // preserving the body's relative indentation. delta >= 0 means dedent.
    const delta = bodyMin - base;
    if (delta > 0) {
      for (let j = i + 1; j < close; j++) {
        if (lines[j].trim() === '') continue;
        const cur = leadingSpaces(lines[j]);
        const remove = Math.min(delta, cur);
        out[j] = lines[j].slice(remove);
      }
    }

    i = close + 1;
  }

  return out.join('\n');
}

export default normalizeFenceIndent;
