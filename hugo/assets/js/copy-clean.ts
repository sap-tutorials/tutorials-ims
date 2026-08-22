// Strip a single leading shell/REPL prompt token per line so pasted commands run
// cleanly. Only leading prompts (after optional whitespace) are removed; mid-line
// characters are never touched. Tokens: `$ `, `> `, `# `, `PS> `, `PS <path>> `.
const PROMPT_RE = /^[ \t]*(?:PS[^>\n]*>|[$>#])[ \t]+/;

export function stripPrompts(text: string): string {
  return text.split('\n').map((line) => line.replace(PROMPT_RE, '')).join('\n');
}
