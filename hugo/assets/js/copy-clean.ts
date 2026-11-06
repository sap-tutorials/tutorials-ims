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
