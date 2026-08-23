// Runtime-safe (plain JS) code-block extractor. Ports the CommonMark fence
// tracking from scripts/parsers/fence-tracker.ts (build-time TS, not importable
// under cds-serve), extended to capture the fence language + accumulate code.

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/**
 * @param {Array<{number:number, content:string}>} steps
 * @returns {Array<{stepRef:number, codeBlockIndex:number, lang:string, code:string}>}
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
    let open = null;          // { marker:string, len:number, lang:string, body:string[] }
    for (const line of lines) {
      if (open) {
        // closing fence: same marker char, length >= opening length, nothing but marker
        const close = line.match(FENCE_OPEN);
        if (close && close[2][0] === open.marker && close[2].length >= open.len && close[3].trim() === '') {
          out.push({ stepRef, codeBlockIndex: idx++, lang: open.lang, code: open.body.join('\n') });
          open = null;
        } else {
          open.body.push(line);
        }
      } else {
        const m = line.match(FENCE_OPEN);
        if (m) open = { marker: m[2][0], len: m[2].length, lang: (m[3] || '').trim(), body: [] };
      }
    }
    // unclosed fence at EOF is discarded (matches CommonMark tolerance for our purposes)
  }
  return out;
}
