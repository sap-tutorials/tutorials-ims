// Runtime-safe (plain JS) code-block extractor. Ports the CommonMark fence
// tracking from scripts/parsers/fence-tracker.ts (build-time TS, not importable
// under cds-serve), extended to capture the fence language + accumulate code.
//
// #freshness-context: each block now also carries `contextBefore` / `contextAfter`
// — the prose paragraph immediately adjacent to the fence. The freshness LLM
// judges a block IN CONTEXT (e.g. an error the surrounding text says is expected)
// instead of in isolation, which was the root cause of the false positives DJ hit.

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

const WINDOW_LINES = 6;   // max prose lines captured on each side of a block
const CHAR_CAP = 700;     // hard cap per side, keeps prompt bounded

function cap(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) : str;
}

// Nearest prose paragraph immediately preceding `openIdx` (walking up). Stops at
// a blank-line paragraph boundary or another fence marker so we never bleed into
// an adjacent code block.
function proseBefore(lines, openIdx) {
  let j = openIdx - 1;
  while (j >= 0 && lines[j].trim() === '') j--;   // skip blank gap directly above
  const acc = [];
  while (j >= 0 && acc.length < WINDOW_LINES) {
    const ln = lines[j];
    if (FENCE_OPEN.test(ln) || ln.trim() === '') break;
    acc.push(ln);
    j--;
  }
  return cap(acc.reverse().join('\n').trim(), CHAR_CAP);
}

// Nearest prose paragraph immediately following `closeIdx` (walking down).
function proseAfter(lines, closeIdx) {
  let j = closeIdx + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const acc = [];
  while (j < lines.length && acc.length < WINDOW_LINES) {
    const ln = lines[j];
    if (FENCE_OPEN.test(ln) || ln.trim() === '') break;
    acc.push(ln);
    j++;
  }
  return cap(acc.join('\n').trim(), CHAR_CAP);
}

/**
 * @param {Array<{number:number, content:string}>} steps
 * @returns {Array<{stepRef:number, codeBlockIndex:number, lang:string, code:string,
 *   contextBefore:string, contextAfter:string}>}
 */
export function extractCodeBlocks(steps) {
  const out = [];
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    const content = step?.content;
    if (typeof content !== 'string' || !content) continue;
    const stepRef = Number(step.number);
    const lines = content.split(/\r?\n/);
    let idx = 0;              // per-step code block index
    let open = null;          // { marker, len, lang, body:[], openIdx }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (open) {
        // closing fence: same marker char, length >= opening length, nothing but marker
        const close = line.match(FENCE_OPEN);
        if (close && close[2][0] === open.marker && close[2].length >= open.len && close[3].trim() === '') {
          out.push({
            stepRef,
            codeBlockIndex: idx++,
            lang: open.lang,
            code: open.body.join('\n'),
            contextBefore: proseBefore(lines, open.openIdx),
            contextAfter: proseAfter(lines, i),
          });
          open = null;
        } else {
          open.body.push(line);
        }
      } else {
        const m = line.match(FENCE_OPEN);
        if (m) open = { marker: m[2][0], len: m[2].length, lang: (m[3] || '').trim(), body: [], openIdx: i };
      }
    }
    // unclosed fence at EOF is discarded (matches CommonMark tolerance for our purposes)
  }
  return out;
}

// ─── Tutorial-level context ─────────────────────────────────────────────────
//
// Document-wide orientation for the freshness LLM: the YAML frontmatter (title/
// tags/domain) and the Prerequisites section (which defines the reader's
// environment — e.g. "a dev container in VS Code / GitHub Codespaces provides a
// shell and the toolchain"). Fed ONCE at the top of the prompt so the model does
// not re-flag setup the prerequisites already establish.

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const PREREQ_HEADING_RE = /^(#{1,6})\s+.*prerequisit/i;
const HEADING_RE = /^(#{1,6})\s+/;

const FRONTMATTER_CAP = 1200;
const PREREQ_CAP = 1500;

// Extract the first section whose heading matches `headingRe`, up to the next
// heading of the same or higher level. Returns '' when absent.
function extractSection(body, headingRe) {
  const lines = body.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return '';
  const acc = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(HEADING_RE);
    if (h && h[1].length <= level) break;   // next section of same/higher level
    acc.push(lines[i]);
  }
  return acc.join('\n').trim();
}

/**
 * @param {string} markdown  raw tutorial source (frontmatter + body)
 * @returns {{ frontmatter: string, prerequisites: string }}
 */
export function extractTutorialContext(markdown) {
  if (typeof markdown !== 'string' || !markdown) {
    return { frontmatter: '', prerequisites: '' };
  }
  let frontmatter = '';
  let body = markdown;
  const fm = markdown.match(FRONTMATTER_RE);
  if (fm) {
    frontmatter = fm[1].trim();
    body = markdown.slice(fm[0].length);
  }
  const prerequisites = extractSection(body, PREREQ_HEADING_RE);
  return {
    frontmatter: cap(frontmatter, FRONTMATTER_CAP),
    prerequisites: cap(prerequisites, PREREQ_CAP),
  };
}
