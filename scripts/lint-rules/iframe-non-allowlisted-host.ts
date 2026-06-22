// scripts/lint-rules/iframe-non-allowlisted-host.ts
//
// Warns when a tutorial markdown file contains an <iframe> whose src host
// is not on the sanitizer allowlist. Without this rule, an author who
// pastes a Vimeo or non-SAP video URL would build successfully, then
// discover at runtime that their iframe was silently stripped by the
// sanitizer (issue #136 / PR #140 design).
//
// Severity: warning (not error). Catalog ships ~138 known iframes; new
// authors who paste an off-allowlist host get a visible warning at lint
// time and can either (a) ask the platform team to extend the allowlist
// + CSP, or (b) switch to an allowlisted host. Does NOT block the build —
// CI invokes lint:tutorial-markdown with continue-on-error: true.
//
// Single-source-of-truth: allowlist is imported from the sanitizer module
// so adding a host to ALLOWED_IFRAME_HOSTNAMES automatically updates the
// lint behavior without code changes here.

import { ALLOWED_IFRAME_HOSTNAMES } from '../parsers/sanitize-html.js'
import type { LintFinding } from '../lint-tutorial-markdown.js'

// Captures `<iframe ... src="..." ...>` on a single line. Catalog grep on
// 2026-06-22 found zero multi-line iframe attributes; the simple line-scan
// regex is sufficient. Global flag enables multi-match iteration via matchAll().
const IFRAME_SRC_RE = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

export const iframeNonAllowlistedHostRule = {
  id: 'iframe-non-allowlisted-host',
  describe: 'iframe src host is not on ALLOWED_IFRAME_HOSTNAMES; sanitizer will silently strip it.',
  scan(slug: string, lines: string[], _rawLines: string[]): LintFinding[] {
    const findings: LintFinding[] = []
    const allow = ALLOWED_IFRAME_HOSTNAMES as readonly string[]
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const match of line.matchAll(IFRAME_SRC_RE)) {
        const src = match[1]
        let host: string
        try {
          host = new URL(src).hostname
        } catch {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            slug,
            file: `${slug}.md`,
            line: i + 1,
            message: `Malformed iframe src "${src}" — sanitizer will silently strip this iframe.`,
            excerpt: line.slice(0, 100),
            severity: 'warning',
          })
          continue
        }
        if (!allow.includes(host)) {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            slug,
            file: `${slug}.md`,
            line: i + 1,
            message: `iframe src host "${host}" is not on the allowlist (${allow.join(', ')}). Sanitizer will silently strip this iframe. Either switch to an allowlisted host or extend the allowlist in scripts/parsers/sanitize-html.ts (see docs/developers/reference/iframe-allowlist.md).`,
            excerpt: line.slice(0, 100),
            severity: 'warning',
          })
        }
      }
    }
    return findings
  },
}
