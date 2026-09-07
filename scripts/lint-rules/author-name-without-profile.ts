// scripts/lint-rules/author-name-without-profile.ts
//
// Warns when a tutorial's frontmatter names an author (author_name) but has no
// author_profile — either the key is absent or present-but-blank. Without a
// profile the platform cannot resolve the author's GitHub identity, so the
// rendered byline shows the author's NAME but (historically) borrowed the
// last-changed-by contributor's avatar and link — attributing the tutorial to a
// different person. Issue #2181 fixes the renderer to fall back to a name-only
// byline; this rule surfaces the missing profile at author-lint time so the
// author can add their profile URL and get a proper avatar + link.
//
// Severity: warning (not error). Missing profiles are common in the legacy
// catalog and must not hard-block the build — CI invokes lint:tutorial-markdown
// with continue-on-error, mirroring iframe-non-allowlisted-host.
//
// Operates on the raw source frontmatter, where keys are snake_case
// (`author_name` / `author_profile`), NOT the camelCase Hugo output frontmatter.

import type { LintFinding } from '../lint-tutorial-markdown.js'

// Frontmatter scalar `key: value` on a single line (leading whitespace tolerated;
// value trimmed). Only the top YAML frontmatter block is inspected.
const FIELD_RE = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/

export const authorNameWithoutProfileRule = {
  id: 'author-name-without-profile',
  describe: 'Frontmatter has author_name but no author_profile — byline cannot link/avatar the author.',
  scan(slug: string, _lines: string[], rawLines: string[]): LintFinding[] {
    // Locate the frontmatter block: opening `---` on the first non-empty line,
    // closing `---` after it. Tutorials without frontmatter are skipped.
    let start = -1
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].trim() === '') continue
      if (rawLines[i].trim() === '---') start = i
      break
    }
    if (start === -1) return []
    let end = -1
    for (let i = start + 1; i < rawLines.length; i++) {
      if (rawLines[i].trim() === '---') { end = i; break }
    }
    if (end === -1) return []

    let authorNameLine = -1
    let authorName = ''
    let authorProfileLine = -1
    let authorProfile = ''
    let sawProfileKey = false

    for (let i = start + 1; i < end; i++) {
      const m = rawLines[i].match(FIELD_RE)
      if (!m) continue
      const key = m[1]
      const value = m[2]
      if (key === 'author_name') { authorNameLine = i; authorName = value }
      else if (key === 'author_profile') { authorProfileLine = i; authorProfile = value; sawProfileKey = true }
    }

    // Only flag when a real author is named but no usable profile is present.
    if (authorName === '' ) return []
    if (authorProfile !== '') return []

    // Anchor the finding at the blank author_profile line when present, else at
    // the author_name line so the author sees where to add the missing field.
    const line = (sawProfileKey ? authorProfileLine : authorNameLine) + 1
    const anchorText = sawProfileKey ? rawLines[authorProfileLine] : rawLines[authorNameLine]
    return [{
      rule: 'author-name-without-profile',
      slug,
      file: `${slug}.md`,
      line,
      message: `author_name "${authorName}" has no author_profile (${sawProfileKey ? 'present but blank' : 'key absent'}). Add "author_profile: https://github.com/<login>" so the byline can show the author's avatar and link; otherwise it renders name-only.`,
      excerpt: (anchorText ?? '').slice(0, 100),
      severity: 'warning',
    }]
  },
}
