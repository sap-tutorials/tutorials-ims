// Strip a single leading shell/REPL prompt token per line so pasted commands run
// cleanly. Only leading prompts (after optional whitespace) are removed; mid-line
// characters are never touched. Tokens: `$ `, `> `, `# `, `PS> `, `PS <path>> `.
const PROMPT_RE = /^[ \t]*(?:PS[^>\n]*>|[$>#])[ \t]+/;

export function stripPrompts(text: string): string {
  return text.split('\n').map((line) => line.replace(PROMPT_RE, '')).join('\n');
}

// Read only command lines from a console block (.code-block-body[data-console]).
// Each .cl-cmd and .cl-cont span carries data-cmd-text with the text after the
// prompt (or the raw textContent as a fallback). Output lines (.cl-out) are
// intentionally excluded — this is the text that goes to the clipboard.
export function copyConsoleCommands(block: HTMLElement): string {
  const spans = block.querySelectorAll<HTMLElement>('.cl-cmd, .cl-cont');
  const lines: string[] = [];
  spans.forEach((el) => {
    const text = el.dataset.cmdText ?? el.textContent ?? '';
    lines.push(text);
  });
  return lines.join('\n');
}

// Strip marker comments from a line of text.
const MARKER_RE = /\s*(?:\/\/|#|<!--|--)\s*\[!code [^\]]+\](?:\s*-->)?/g;

// Copy "final state" from a diff-annotated block: removed lines excluded, markers stripped.
// If block.dataset.copyRaw === 'true', returns the original source (with markers) stored in
// data-raw-content (HTML-decoded), because the Chroma highlight path strips markers before
// rendering so textContent never contains them.
export function copyDiffFinal(block: HTMLElement): string {
  if (block.dataset.copyRaw === 'true') {
    // Hugo emits the original .Inner via {{ .Inner | htmlEscape }} into data-raw-content.
    // The dataset access decodes HTML entities automatically.
    return block.dataset.rawContent ?? block.textContent ?? '';
  }
  const lines = block.querySelectorAll<HTMLElement>('.line');
  if (lines.length === 0) {
    // Fallback: no .line spans; strip markers from full text
    return (block.textContent ?? '').replace(MARKER_RE, '');
  }
  const result: string[] = [];
  lines.forEach((line) => {
    if (line.classList.contains('diff-removed')) return;
    const text = (line.textContent ?? '').replace(MARKER_RE, '');
    result.push(text);
  });
  return result.join('\n');
}
