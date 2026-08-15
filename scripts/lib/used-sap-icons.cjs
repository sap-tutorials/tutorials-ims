// scripts/lib/used-sap-icons.cjs
//
// Shared source scanner for the fundamental-styles icon subset (issue #1779).
//
// The full fundamental-styles icon.css ships ~800 `sap-icon--<glyph>` classes
// (three icon fonts: SAP-icons, SAP-icons-TNT, BusinessSuiteInAppSymbols). The
// homepage/navigator use `<ui5-icon>` web components (their own font) — the CSS
// glyph classes are used on only a handful of surfaces. This module is the
// single source of truth for WHICH `sap-icon--<glyph>` classes the site ships,
// consumed by both:
//   - scripts/build-icon-subset.cjs  (emits the subset CSS)
//   - test/icon-subset-guard.test.js (fails CI if a used glyph is not subsetted)
// Keeping one scanner means the generator and the guard can never disagree.
//
// Scope: Hugo layouts/content/data, the Vue islands, and the CAP srv/ renderers.
// We deliberately DO NOT scan app/ — the UI5/Fiori admin + scanner apps resolve
// icons via the `sap-icon://<name>` URI form against UI5's OWN icon CSS (loaded
// from ui5.sap.com), never via the Hugo-shipped fundamental-styles glyph classes.
// (The `sap-icon://` URI form does not match the `sap-icon--` class pattern, so
// it is excluded automatically regardless.)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directories whose rendered output is styled by the Hugo-shipped icon CSS.
const SCAN_DIRS = [
  'hugo/layouts',
  'hugo/content',
  'hugo/data',
  'hugo-apps/src',
  'srv',
];

const SCAN_EXTS = new Set([
  '.html', '.vue', '.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.md', '.toml', '.json',
]);

// Modifier classes (size / color / background) are structural, not glyphs — the
// subset always keeps ALL of them, so the scanner filters them out of the
// "glyph" set it returns.
const MODIFIER_RE = /^(sm|md|lg|xl|xxl|color-.*|background-.*)$/;

// Match the class form `sap-icon--<name>`. The URI form `sap-icon://<name>`
// (UI5) never matches because `//` is not `--`.
const CLASS_RE = /sap-icon--([a-z0-9-]+)/g;

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir may not exist (e.g. hugo/content/tutorials before fetch)
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

/**
 * Scan the source tree for used `sap-icon--<glyph>` class names.
 * @param {string} repoRoot absolute path to the repo root
 * @returns {{ glyphs: string[], byFile: Record<string,string[]> }}
 *   glyphs: sorted unique glyph names (modifiers excluded)
 *   byFile: repo-relative file -> sorted glyphs found in it (for diagnostics)
 */
function scanUsedGlyphs(repoRoot) {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(repoRoot, d), files);

  const glyphs = new Set();
  const byFile = {};
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const local = new Set();
    let m;
    CLASS_RE.lastIndex = 0;
    while ((m = CLASS_RE.exec(text)) !== null) {
      const name = m[1];
      if (MODIFIER_RE.test(name)) continue; // keep modifiers in subset, not here
      glyphs.add(name);
      local.add(name);
    }
    if (local.size) {
      byFile[path.relative(repoRoot, file).split(path.sep).join('/')] = [...local].sort();
    }
  }
  return { glyphs: [...glyphs].sort(), byFile };
}

module.exports = { scanUsedGlyphs, SCAN_DIRS, MODIFIER_RE };
