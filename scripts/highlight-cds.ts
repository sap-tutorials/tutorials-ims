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

    let changed = false;
    let result = '';
    let cursor = 0;

    while (true) {
      const markerIdx = html.indexOf(MARKER, cursor);
      if (markerIdx === -1) break;

      const blockStart = html.lastIndexOf('<div', markerIdx);
      if (blockStart === -1) { cursor = markerIdx + 1; continue; }

      const bodyStart = html.indexOf('<div class=code-block-body>', markerIdx);
      if (bodyStart === -1) { cursor = markerIdx + 1; continue; }

      const bodyContentStart = bodyStart + '<div class=code-block-body>'.length;

      // Find the matching </div> — the body ends at the next </div></div> sequence
      // that closes code-block-body and code-block
      const bodyEndTag = '</div></div>';
      let bodyEnd = html.indexOf(bodyEndTag, bodyContentStart);
      if (bodyEnd === -1) { cursor = markerIdx + 1; continue; }

      const bodyContent = html.substring(bodyContentStart, bodyEnd);
      const rawCode = extractCode(bodyContent);

      if (!rawCode) { cursor = bodyEnd + bodyEndTag.length; continue; }

      const highlighted = highlighter.codeToHtml(rawCode, {
        lang: 'cds',
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false
      });

      result += html.substring(cursor, bodyContentStart);
      result += highlighted;
      cursor = bodyEnd;
      changed = true;
      processedBlocks++;
    }

    result += html.substring(cursor);

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

main().catch((err) => {
  console.error('highlight-cds failed:', err);
  process.exit(1);
});
