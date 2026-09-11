'use strict';

/**
 * Pure, runtime per-step splitter for a tutorial's **source markdown**, used by
 * the MCP `get_tutorial_step` tool when `format='markdown'` (#2244).
 *
 * This is a self-contained port of the build-time parser-v2 step splitter
 * (`scripts/parsers/v2.ts`, fence-aware via `fence-tracker.ts`, comment-aware
 * via `html-comment-lines.ts`). It lives in `srv/lib/` — not imported from
 * `scripts/` — because the parsers are build-time TypeScript and the serve-time
 * bundle (and the `srv-qa` cp-list) must stay free of a cross-tree dependency.
 *
 * Boundaries and 1-indexed numbering mirror `parseV2Steps` by construction, so
 * a markdown slice agrees with the HTML slicer's `data-step-number` /
 * `h2.step-title` for the same tutorial: both derive from the same `###`
 * headings in document order.
 *
 * Kept in sync with:
 *   - scripts/parsers/v2.ts             (H3 split, [VALIDATE_n]/[DONE] stripping)
 *   - scripts/parsers/fence-tracker.ts  (CommonMark fence rules)
 *   - scripts/parsers/html-comment-lines.ts (multi-line <!-- --> masking)
 *
 * Pure: no I/O, safe to unit-test directly.
 */

import { stripImageDirectiveComments } from './tutorial-markdown.js';

const VALIDATE_LINE = /^\s*\[VALIDATE_\d+\]\s*$/;
const DONE_LINE = /^\s*\[DONE\]\s*$/;
const H3 = /^### (.+)$/;

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(\s{0,3})(`{3,}|~{3,})\s*$/;

/**
 * Stateful CommonMark fence tracker — returns true while inside a fenced code
 * block (including the delimiter lines), so a caller skips block-level matching
 * (a `###` quoted inside a fence is literal, not a phantom step).
 * Ported from scripts/parsers/fence-tracker.ts.
 */
function createFenceTracker() {
  let fenceChar = null;
  let fenceLen = 0;
  return function inFence(line) {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN);
      if (open) {
        fenceChar = open[2][0];
        fenceLen = open[2].length;
        return true;
      }
      return false;
    }
    const close = line.match(FENCE_CLOSE);
    if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
      fenceChar = null;
      fenceLen = 0;
      return true;
    }
    return true;
  };
}

/**
 * Per-line mask: is the line inside a *multi-line* `<!-- ... -->` comment
 * (including opener/closer)? Fence-aware. Single-line self-contained comments
 * (image directives, descriptions) are NOT flagged.
 * Ported from scripts/parsers/html-comment-lines.ts.
 */
function commentLineFlags(lines) {
  const fence = createFenceTracker();
  const flags = new Array(lines.length).fill(false);
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence(line)) continue;
    if (inComment) {
      flags[i] = true;
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const open = line.indexOf('<!--');
    if (open === -1) continue;
    if (line.indexOf('-->', open + 4) !== -1) continue;
    flags[i] = true;
    inComment = true;
  }
  return flags;
}

function stripMarkers(lines) {
  return lines.filter((l) => !VALIDATE_LINE.test(l) && !DONE_LINE.test(l));
}

/**
 * Best-effort markdown → plaintext projection, so `textLength` on the tool
 * result is a meaningful character count (parity with the HTML slicer's
 * `stripHtml` text). Not a full markdown renderer — strips the syntax an agent
 * doesn't need to count: fences, inline code, headings, emphasis, list markers,
 * and link/image wrappers (keeping alt/link text).
 */
function stripMarkdownToText(md) {
  return md
    .replace(/```[^\n]*\n?|~~~[^\n]*\n?/g, ' ') // fence delimiters
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')    // images → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links → link text
    .replace(/`+/g, '')                          // inline code ticks
    .replace(/^#{1,6}\s+/gm, '')                 // heading markers
    .replace(/[*_>]/g, '')                       // emphasis / blockquote marks
    .replace(/^\s*[-+]\s+/gm, '')                // unordered list markers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split source markdown into steps keyed on `###` (H3) headings, matching the
 * parser-v2 numbering the HTML slicer uses.
 *
 * @param {string} body Source markdown (as stored in ContentFiles.sourceContent).
 * @returns {Array<{number:number,title:string,markdown:string,text:string}>}
 *   Steps in document order (1-indexed). `markdown` leads with the step's own
 *   `### {title}` heading and has image-directive comments + [VALIDATE_n]/[DONE]
 *   markers stripped. Empty array when there are no H3 steps.
 */
function parseMarkdownSteps(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const fence = createFenceTracker();
  const commented = commentLineFlags(lines);

  const raw = [];
  let currentTitle = '';
  let currentLines = [];
  let inStep = false;

  const flush = () => {
    if (!inStep) return;
    raw.push({ title: currentTitle, content: stripMarkers(currentLines).join('\n').trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence(line)) {
      if (inStep) currentLines.push(line);
      continue;
    }
    if (commented[i]) continue;

    const h3 = line.match(H3);
    if (h3) {
      flush();
      currentTitle = h3[1].trim();
      currentLines = [];
      inStep = true;
      continue;
    }
    if (inStep) currentLines.push(line);
  }
  flush();

  return raw.map((s, idx) => {
    const heading = `### ${s.title}`;
    const stripped = stripImageDirectiveComments(s.content).trim();
    const markdown = stripped ? `${heading}\n\n${stripped}` : heading;
    return {
      number: idx + 1,
      title: s.title,
      markdown,
      text: stripMarkdownToText(markdown),
    };
  });
}

export { parseMarkdownSteps, stripMarkdownToText };
