'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Match:
//  - safeHTML / safeHTMLAttr Hugo pipeline calls
//  - printf "<...%s..." patterns that assemble raw HTML strings
const PATTERN = /\b(safeHTML|safeHTMLAttr)\b|printf\s+["`][^"`]*<[^"`]*%s/i;
const MARKER = /security-reviewed:/i;
const MARKER_WINDOW = 3; // must be within 3 lines above (or on the same line)

/**
 * Scan a set of Hugo template files for safeHTML / safeHTMLAttr / printf-HTML
 * usages that lack an adjacent `security-reviewed:` marker.
 *
 * @param {Map<string, string>} files - path → contents
 * @returns {{ok: boolean, findings: Array<{file: string, line: number, snippet: string}>}}
 */
function checkHugoSafeHtml(files) {
  const findings = [];
  for (const [file, contents] of files) {
    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!PATTERN.test(line)) continue;
      // Look for marker within MARKER_WINDOW lines above (inclusive of same line).
      const windowStart = Math.max(0, i - MARKER_WINDOW);
      let hasMarker = false;
      for (let j = windowStart; j <= i; j++) {
        if (MARKER.test(lines[j])) { hasMarker = true; break; }
      }
      if (!hasMarker) {
        findings.push({ file, line: i + 1, snippet: line.trim() });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

// Extensions to scan under hugo/layouts. Kept broad enough so any Hugo template
// file (HTML, XML sitemap, XSL) is caught.
const TEMPLATE_EXTS = new Set(['.html', '.xml', '.xsl']);

function walkTemplateFiles(dir, acc = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTemplateFiles(full, acc);
    } else if (TEMPLATE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      acc.set(full, fs.readFileSync(full, 'utf8'));
    }
  }
  return acc;
}

function main() {
  const root = path.resolve(__dirname, '..', 'hugo', 'layouts');
  if (!fs.existsSync(root)) {
    console.error(`hugo/layouts not found at ${root}`);
    process.exit(1);
  }
  const files = walkTemplateFiles(root);
  const { ok, findings } = checkHugoSafeHtml(files);
  if (ok) {
    console.log(`check-hugo-safe-html: OK (${files.size} files scanned)`);
    process.exit(0);
  }
  console.error(`check-hugo-safe-html: ${findings.length} unmarked safeHTML/printf usage(s) found:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.snippet}`);
  }
  console.error('');
  console.error('Add a comment on (or within 3 lines above) each occurrence explaining why the source is trusted, prefixed with "security-reviewed:". See #797.');
  process.exit(2);
}

module.exports = { checkHugoSafeHtml, walkTemplateFiles };

if (require.main === module) main();
