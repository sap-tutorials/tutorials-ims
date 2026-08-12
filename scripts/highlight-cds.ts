import { createHighlighter } from 'shiki';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const GRAMMAR_PATH = join(__dirname, 'grammars', 'cds.tmLanguage.json');

// The directory of rendered Hugo HTML to post-process. Defaults to hugo/public
// (the DEV/PROD publishDir used by build:all and rebuild-content.yml). The QA
// channel renders to hugo/public-qa (hugo.qa.toml), so rebuild-content-qa.yml
// passes `--dir hugo/public-qa`. Env HIGHLIGHT_DIR is honored as a fallback.
// Relative paths resolve against the repo root (scripts/..), matching the
// hardcoded default this replaced. See issue #1657.
function resolveOutputDir(): string {
  const argIdx = process.argv.indexOf('--dir');
  const raw =
    (argIdx !== -1 ? process.argv[argIdx + 1] : undefined) ||
    process.env.HIGHLIGHT_DIR ||
    'hugo/public';
  return resolve(__dirname, '..', raw);
}

const OUTPUT_DIR = resolveOutputDir();

function findHtmlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...findHtmlFiles(full));
    } else if (entry.endsWith('.html')) {
      files.push(full);
    }
  }
  return files;
}

function extractCode(bodyHtml: string): string {
  const codeMatch = bodyHtml.match(/<code[^>]*>([\s\S]*?)<\/code>/);
  if (!codeMatch) return '';
  return codeMatch[1]
    .replace(/<span[^>]*>/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/\n$/, '');
}

/**
 * Replace each CDS code block (marked `data-lang=cds`) in `html` with the output
 * of `highlightFn(rawCode)` (Shiki, which returns a bare `<pre>…</pre>` with NO
 * wrapping div). Pure over its inputs so div-balance is unit-testable.
 *
 * The input body is Chroma's `<div class=highlight><pre…>…</pre></div>` inside a
 * `<div class=code-block-body>`. We discard that whole `<div class=highlight>…`
 * body and splice Shiki's `<pre>` in its place, so we MUST also consume Chroma's
 * matching closing `</div>` — otherwise every CDS block leaks one unbalanced
 * `</div>` (issue #1657 regression: right rail ejected from the two-col grid).
 */
export function replaceCdsBlocks(
  html: string,
  highlightFn: (rawCode: string) => string,
  marker = 'data-lang=cds'
): { result: string; changed: boolean; processedBlocks: number } {
  let result = '';
  let cursor = 0;
  let changed = false;
  let processedBlocks = 0;

  while (true) {
    const markerIdx = html.indexOf(marker, cursor);
    if (markerIdx === -1) break;

    const blockStart = html.lastIndexOf('<div', markerIdx);
    if (blockStart === -1) { cursor = markerIdx + 1; continue; }

    const bodyStart = html.indexOf('<div class=code-block-body>', markerIdx);
    if (bodyStart === -1) { cursor = markerIdx + 1; continue; }

    const bodyContentStart = bodyStart + '<div class=code-block-body>'.length;

    // Find the matching </div> — the body ends at the next </div></div> sequence
    // that closes code-block-body and code-block
    const bodyEndTag = '</div></div>';
    const bodyEnd = html.indexOf(bodyEndTag, bodyContentStart);
    if (bodyEnd === -1) { cursor = markerIdx + 1; continue; }

    const bodyContent = html.substring(bodyContentStart, bodyEnd);
    const rawCode = extractCode(bodyContent);

    if (!rawCode) { cursor = bodyEnd + bodyEndTag.length; continue; }

    const highlighted = highlightFn(rawCode);

    result += html.substring(cursor, bodyContentStart);
    result += highlighted;
    // `bodyEnd` sits at Chroma's `<div class=highlight>` CLOSING </div> (its opening
    // div lived inside `bodyContent`, which we just discarded and replaced with
    // Shiki's div-less <pre>). Consume that orphaned </div> so the remaining tail is
    // `</div></div>` (code-block-body + code-block) — 2 closes matching the 2 opens
    // we kept. Without this, every CDS block leaks one </div> (#1657 → right rail
    // ejected from the two-column grid).
    cursor = bodyEnd + '</div>'.length;
    changed = true;
    processedBlocks++;
  }

  result += html.substring(cursor);
  return { result, changed, processedBlocks };
}

async function main() {
  const grammar = JSON.parse(readFileSync(GRAMMAR_PATH, 'utf-8'));

  const highlighter = await createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: [{ ...grammar, name: 'cds' }]
  });

  const htmlFiles = findHtmlFiles(OUTPUT_DIR);
  let processedBlocks = 0;
  let processedFiles = 0;
  let filesWithMarker = 0;

  const MARKER = 'data-lang=cds';

  for (const file of htmlFiles) {
    let html = readFileSync(file, 'utf-8');
    if (!html.includes(MARKER)) continue;
    filesWithMarker++;

    const { result, changed, processedBlocks: blocksInFile } = replaceCdsBlocks(
      html,
      (rawCode) => highlighter.codeToHtml(rawCode, {
        lang: 'cds',
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false
      }),
      MARKER
    );
    processedBlocks += blocksInFile;

    if (changed) {
      writeFileSync(file, result, 'utf-8');
      processedFiles++;
    }
  }

  console.log(`CDS highlighting: ${processedBlocks} blocks in ${processedFiles} files (dir: ${OUTPUT_DIR})`);
  highlighter.dispose();

  // Regression guard (#1657): if the `data-lang=cds` marker is present but we
  // replaced zero blocks, the block structure this matcher relies on (emitted
  // by render-codeblock.html, minified by Hugo) has drifted. Failing here turns
  // a silent revert-to-Chroma-SQL (braces rendered as red `.err` tokens) into a
  // red build BEFORE the un-highlighted HTML is published to HANA.
  if (filesWithMarker > 0 && processedBlocks === 0) {
    console.error(
      `highlight-cds: found ${filesWithMarker} file(s) with the '${MARKER}' marker but replaced 0 CDS blocks — ` +
        `the code-block markup likely drifted from what this script matches. Refusing to leave the Chroma-SQL fallback in place.`
    );
    process.exit(1);
  }
}

// Only run the file-scanning entry point when executed directly (build:highlight
// → `tsx scripts/highlight-cds.ts`). When imported by a unit test, skip main()
// so `replaceCdsBlocks` can be exercised in isolation.
const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    console.error('highlight-cds failed:', err);
    process.exit(1);
  });
}
