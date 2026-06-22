# Tutorial iframe host allowlist - Design

**Date:** 2026-06-22
**Issue / PR:** to-be-filed (post-PR #558)
**Status:** Approved (Tom + Claude, 2026-06-22)

## Problem

Tutorial markdown in the `sap-tutorials` GitHub org contains `<iframe>` elements pointing at SAP-blessed video hosts (YouTube, openSAP microlearning, SAP video service). The current sanitizer at `scripts/parsers/sanitize-html.ts` strips every iframe at build time, so **138 iframe occurrences across ~65 tutorials silently disappear** from the new tutorial system.

The strip came from a deliberate security hardening in PR #141 / issue #136 (the regex sanitizer to `sanitize-html` migration). Iframe was placed in the dangerous-tags set to be dropped because the old regex sanitizer could not reliably enforce a hostname allowlist. The new `sanitize-html` library *does* support hostname allowlisting via its `allowedIframeHostnames` option, so we can re-introduce iframes narrowly without giving back the security gain.

User report that surfaced this: `/tutorials/hana-cloud-cap-create-project` is missing the "Video Version" YouTube embed that appears on the legacy AEM page at `developers.sap.com/tutorials/hana-cloud-cap-create-project.html`.

## Catalog scope

Counts derived from grep over `.tutorial-cache/*.md` (2026-06-22):

| Host | iframe occurrences |
|---|---|
| `www.youtube.com` | 129 |
| `microlearning.opensap.com` | 7 |
| `youtu.be` | 1 |
| `sapvideo.cfapps.eu10-004.hana.ondemand.com` | 1 |
| **Total** | **138** in ~65 tutorials |

All four hosts are SAP-blessed and author-controlled (the tutorial source is in the private `sap-tutorials` GitHub org; iframes are not user-supplied input).

## Goals

1. **Restore iframe rendering** for the 138 occurrences without expanding the attack surface to arbitrary iframes.
2. **Defense in depth.** A failure of any single enforcement layer cannot expose users to a malicious iframe.
3. **Author feedback at PR time.** When an author commits a tutorial with an iframe pointing to a non-allowlisted host, they get a visible warning *before* the build silently strips their content.
4. **Traceable.** The reintroduction of iframes is documented loudly enough that a future security audit understands the deliberate scope and does not re-strip them.

## Non-goals

- **Arbitrary iframe hosts.** No support for `vimeo.com`, `dailymotion.com`, etc. unless the platform team adds them through the documented allowlist-extension flow.
- **Multi-line iframes.** Catalog inspection shows zero multi-line iframe attributes; the lint regex assumes single-line. If this assumption fails for a future tutorial, the lint silently misses it but the sanitizer still strips it - acceptable.
- **`srcdoc` support.** Inline-HTML-in-iframe via `srcdoc` would bypass the host allowlist; we deliberately exclude this attribute. Authors who want inline content use markdown.
- **Same-origin iframes.** Nothing in the codebase needs to iframe in-domain pages today; we do not add `'self'` to `frame-src`. If this changes, it is a separate design decision.

## Architecture: three enforcement layers

```
+---------------------------------------------------------------------+
| Layer 1: Build-time sanitizer (scripts/parsers/sanitize-html.ts)    |
|   sanitize-html package, allowedIframeHostnames option              |
|   Iframes on non-allowlisted hosts -> stripped before HTML emission |
+---------------------------------------------------------------------+
                                  |
                                  v
+---------------------------------------------------------------------+
| Layer 2: Runtime CSP (approuter/xs-app.json frame-src)              |
|   Browser refuses to render iframes whose src host is not in        |
|   frame-src. Survives a hypothetical sanitizer bypass.              |
+---------------------------------------------------------------------+
                                  |
                                  v
+---------------------------------------------------------------------+
| Layer 3: PR-time author lint (scripts/lint-rules/...)               |
|   Warns the author at PR / rebuild-content CI time when a tutorial  |
|   commits an iframe whose host is not on the allowlist.             |
|   Imports ALLOWED_IFRAME_HOSTNAMES from the sanitizer module so     |
|   there is exactly one source of truth.                             |
+---------------------------------------------------------------------+
```

## Single source of truth

The hostname allowlist lives in **one place**: an exported `ALLOWED_IFRAME_HOSTNAMES` constant in `scripts/parsers/sanitize-html.ts`. The lint rule imports it. The CSP header in `approuter/xs-app.json` and the doc page at `docs/developers/reference/iframe-allowlist.md` are duplicates *by necessity* (CSP is a single string in a JSON file; docs are prose). The allowlist-extension procedure in the doc page makes the three-place update explicit.

## Layer 1: sanitizer changes

### File: `scripts/parsers/sanitize-html.ts`

**Add at module top, near `SEMANTIC_TAGS`:**

```ts
// Iframe host allowlist - author-controlled embeds from trusted SAP video
// hosts. Authors do NOT supply user input here; iframes come from tutorial
// markdown checked into the sap-tutorials GitHub org. Re-introduces what
// #140 (sanitize-html migration) intentionally stripped - narrowly, with
// hostname enforcement that the previous regex sanitizer could not express.
//
// THREE PLACES MUST BE UPDATED TOGETHER when extending the allowlist:
//   1. This constant
//   2. approuter/xs-app.json - frame-src directive
//   3. docs/developers/reference/iframe-allowlist.md - host table
//
// scripts/lint-rules/iframe-non-allowlisted-host.ts auto-updates because
// it imports this constant.
export const ALLOWED_IFRAME_HOSTNAMES = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'microlearning.opensap.com',
  'sapvideo.cfapps.eu10-004.hana.ondemand.com',
] as const
```

**Extend `ALLOWED_TAGS`:**

```ts
const ALLOWED_TAGS = [...SEMANTIC_TAGS, 'iframe']
```

**Extend `ALLOWED_ATTRS`:**

```ts
const ALLOWED_ATTRS: Record<string, ...> = {
  // ... existing entries unchanged ...
  iframe: ['src', 'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'title', 'loading', 'referrerpolicy'],
}
```

**Extend `SANITIZE_OPTS`:**

```ts
const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  // ... existing options unchanged ...
  allowedIframeHostnames: ALLOWED_IFRAME_HOSTNAMES as unknown as string[],
  allowedIframeRelativeUrls: false,  // never permit relative-src iframes
}
```

**Iframe stays in `KNOWN_HTML_TAGS`** (line 51 area) so pseudo-tag escaping still excludes it. No change there.

### Iframe attribute allowlist rationale

| Attribute | Why allowed |
|---|---|
| `src` | The URL. Hostname-checked by `allowedIframeHostnames`. Scheme-checked by existing `allowedSchemes`. |
| `width`, `height` | Author-controlled sizing. Catalog convention: 560 by 315 for YouTube. |
| `frameborder` | Legacy attribute. Harmless. Present in ~95% of catalog iframes. |
| `allow` | Feature-policy delegation (accelerometer, autoplay, clipboard-write, ...). YouTube embed code includes this by default. |
| `allowfullscreen` | Fullscreen permission flag. Author-friendly UX. |
| `title` | a11y label. Often missing - lint should encourage but does not require. |
| `loading="lazy"` | Performance. Harmless. |
| `referrerpolicy` | Privacy. Harmless. |

**Deliberately excluded:**

| Attribute | Why excluded |
|---|---|
| `srcdoc` | Bypasses host allowlist by allowing inline HTML content. |
| `name` | Deprecated DOM-targeting attribute. |
| `sandbox` | Authors should not be relaxing our defaults. |
| `on*` event handlers | Already stripped by sanitize-html. Documented here for completeness. |

## Layer 2: CSP changes

### File: `approuter/xs-app.json` line 6

Current `frame-src` directive (extracted from the single CSP header):

```
frame-src https://www.youtube.com
```

New value:

```
frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com
```

**No QA-specific update needed.** The QA channel reuses the same approuter; there is no `approuter-qa/` directory.

**Verified at design time:** the deployed approuter at `tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com` returns `frame-src https://www.youtube.com` matching `xs-app.json` exactly - no out-of-band `cf set-env` override in play (cf. memory `feedback_cf_set_env_drops_on_redeploy`).

### Why `youtu.be` needs an explicit entry

Browsers evaluate CSP `frame-src` against the **original** `src` URL host *before* any redirect. `https://youtu.be/dQw4w9WgXcQ` (the raw share-link form) redirects to `https://www.youtube.com/watch?v=...` at the HTTP layer, but the CSP check fires first. Without an explicit `youtu.be` entry, the iframe loads in the DOM but the browser blocks the navigation.

## Layer 3: lint rule

### New file: `scripts/lint-rules/iframe-non-allowlisted-host.ts`

```ts
// scripts/lint-rules/iframe-non-allowlisted-host.ts
//
// Warns when a tutorial markdown contains an <iframe> whose src host
// is not on the sanitizer allowlist. Without this rule, an author who
// pastes a Vimeo or non-SAP video URL would build successfully, then
// discover at runtime that their iframe was silently stripped by the
// sanitizer (issue #136 / PR #140 design).
//
// Severity: warning (not fail). Catalog ships ~138 known iframes; new
// authors who paste an off-allowlist host get a visible warning at lint
// time and can either (a) ask the platform team to extend the allowlist
// + CSP, or (b) switch to an allowlisted host. Does not block the build.
//
// Single-source-of-truth: allowlist is imported from the sanitizer module.

import { ALLOWED_IFRAME_HOSTNAMES } from '../parsers/sanitize-html.js'
import type { Rule, Finding } from '../lint-tutorial-markdown.js'

// Captures `<iframe ... src="..." ...>` on a single line.
// (Catalog grep on 2026-06-22 found zero multi-line iframe attributes.)
const IFRAME_SRC_RE = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

export const iframeNonAllowlistedHost: Rule = {
  name: 'iframe-non-allowlisted-host',
  severity: 'warning',
  check(content, filename) {
    const findings = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      IFRAME_SRC_RE.lastIndex = 0
      let match
      while ((match = IFRAME_SRC_RE.exec(lines[i])) !== null) {
        const src = match[1]
        let host
        try {
          host = new URL(src).hostname
        } catch {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            file: filename,
            line: i + 1,
            message: 'Malformed iframe src "' + src + '" will be stripped by sanitizer.',
          })
          continue
        }
        if (!ALLOWED_IFRAME_HOSTNAMES.includes(host)) {
          findings.push({
            rule: 'iframe-non-allowlisted-host',
            file: filename,
            line: i + 1,
            message: 'iframe src host "' + host + '" is not on the allowlist. Will be silently stripped by sanitizer.',
          })
        }
      }
    }
    return findings
  },
}
```

### Runner severity-aware changes: `scripts/lint-tutorial-markdown.ts`

**`Rule` interface gains `severity` field:**

```ts
interface Rule {
  name: string
  severity: 'warning' | 'error'  // NEW
  check(content: string, filename: string): Finding[]
}

interface Finding {
  rule: string
  file: string
  line: number
  message: string
  severity?: 'warning' | 'error'  // NEW, populated by runner from Rule.severity
}
```

**Existing rule tagged:**

```ts
import { indentedNumberedListItem } from './lint-rules/indented-numbered-list-item.js'
import { iframeNonAllowlistedHost } from './lint-rules/iframe-non-allowlisted-host.js'

// indentedNumberedListItem keeps severity: 'error' (preserves its current
// fail-loud behavior added when the rule was introduced).
const RULES: Rule[] = [indentedNumberedListItem, iframeNonAllowlistedHost]
```

The exact location of the existing rule severity tag depends on where `indentedNumberedListItem` lives today (the runner has it inline at ~line 160; the implementation will move it to `scripts/lint-rules/indented-numbered-list-item.ts` if it is not there already, to match the new rule structure).

**Exit code logic:**

- Exit `1` only if there is at least one `error`-severity finding.
- Exit `0` if findings are warning-only or empty.

**Runner print format:**

```
[WARN]  iframe-non-allowlisted-host  .tutorial-cache/foo.md:42
        iframe src host "vimeo.com" is not on the allowlist ...

[ERROR] indented-numbered-list-item  .tutorial-cache/bar.md:18
        ...

Summary: 1 error, 1 warning across 2 files
```

**JSON artifact shape:**

```json
{
  "rule": "iframe-non-allowlisted-host",
  "severity": "warning",
  "file": ".tutorial-cache/foo.md",
  "line": 42,
  "message": "..."
}
```

The downstream consumer (CI artifact upload at `.github/workflows/rebuild-content.yml`) reads the JSON as-is; the new `severity` field is additive.

## CI integration: no workflow changes

`npm run lint:tutorial-markdown` runs in **both** `rebuild-content.yml` and `rebuild-content-qa.yml` with `continue-on-error: true` and uploads the JSON report as a CI artifact. Today's wiring already supports non-blocking lint output. The severity-aware exit-code change keeps `error` findings fail-loud (preserving today's behavior for `indentedNumberedListItem`) while letting the new `warning`-severity rule print without failing CI.

No edits to `.github/workflows/` files.

## Test coverage

### Sanitizer: `scripts/__tests__/sanitize-html.test.ts` (10 new cases added to the existing file)

1. YouTube `/embed/` iframe survives with `src`, `width`, `height`, `frameborder`, `allow`, `allowfullscreen`, `title` attributes preserved
2. `youtu.be` short-link iframe survives
3. `microlearning.opensap.com` iframe survives
4. `sapvideo.cfapps.eu10-004.hana.ondemand.com` iframe survives
5. Off-allowlist iframe (`vimeo.com`) is stripped entirely
6. `srcdoc` attribute on an allowlisted iframe is stripped (defense-in-depth on attribute allowlist)
7. `onload` / `onerror` event handlers on iframes are stripped (assert iframe-specific case)
8. Relative-URL iframe (`src="/api/foo"`) is stripped (confirms `allowedIframeRelativeUrls: false`)
9. `javascript:` scheme in iframe `src` is stripped (assert `allowedSchemesAppliedToAttributes` covers `src`)
10. Pseudo-tag handling unchanged - `<iframe-like-thing>` (hyphenated, looks like an author placeholder) is escaped to literal text, not consumed as a tag

### Lint: `test/unit/lint-tutorial-markdown.test.js` (5 new cases added)

1. `iframe-non-allowlisted-host` fires on a Vimeo iframe - 1 finding, `severity: 'warning'`, correct line number, message mentions "vimeo.com"
2. YouTube + microlearning iframes do not fire - 0 findings
3. Malformed iframe `src` (non-URL string like `src="not a url"`) fires - 1 finding mentioning "Malformed"
4. Multiple iframes on the same line each get their own finding
5. Severity-aware runner — existing `indentedNumberedListItem` rule still tagged `severity: 'error'`. **Single runner invocation** with mixed fixture (1 error finding + 1 warning finding from the iframe rule) verifies all three exit-code branches: runner exits 1 on error-only findings, exits 0 on warning-only findings, exits 1 when both severities are present. Test asserts both stdout format (`[ERROR]` and `[WARN]` prefixes both present) and exit code.

## Documentation

### New file: `docs/developers/reference/iframe-allowlist.md`

Approximately 40 lines documenting:

- The three-layer enforcement architecture (sanitizer -> CSP -> lint)
- Current allowlist with rationale per host
- The three-place allowlist-extension procedure (sanitizer constant, CSP, this doc)
- History: link to PR #141 (#140) for the original strip + this PR for the re-introduction

### VitePress sidebar

Add an entry to `docs/.vitepress/config.ts` under the developers/reference section so `npm run predocs:build` passes (memory `feedback_vitepress_mtaext_dead_links`).

## Traceability

Three places memorialize that this PR re-introduces something #140 deliberately stripped:

1. **`ALLOWED_IFRAME_HOSTNAMES` docstring** in `sanitize-html.ts` - references #140 directly.
2. **`iframe-allowlist.md` history section** - links both PRs.
3. **Commit message body** - explicit cross-reference using the project `#NNN` convention.

A future security pass who greps for `#140` or audits sanitize-html.ts encounters all three.

## Rollout

1. Land PR (no MTA redeploy yet - Tom is batching with other in-flight fixes).
2. When the next MTA redeploy ships, three things activate at once:
   - The sanitizer accepts allowlisted iframes
   - The CSP frame-src permits them
   - The next `rebuild-content` workflow run lints + uploads the warning artifact
3. The next `rebuild-content` run after the deploy regenerates Hugo HTML for all 138 affected occurrences; `publish-content` ships them as part of its standard delta. (Per memory `project_publish_content_hardening_followup`, the publish CLI is correctness-equivalent in default + force modes - no special handling needed.)
4. Visual confirmation: load `/tutorials/hana-cloud-cap-create-project` after the deploy + publish; expect the YouTube iframe to render under "Video Version".

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A future security audit re-strips iframes from `ALLOWED_TAGS` without understanding the deliberate scope. | Three layers of traceability (docstring, doc page, commit message) all reference #140 and explain why iframes are back. |
| The allowlist constant drifts out of sync with the CSP. | Doc page makes the three-place update explicit. Severity-aware lint runner gives a console warning for any iframe whose host is not on the constant - surfaces drift fast. |
| `youtu.be` short-link iframes still fail because the browser follows the redirect to `www.youtube.com` but the browser blocks the iframe before the redirect. | Explicit `https://youtu.be` entry in `frame-src` per Layer 2 design. Sanitizer test case #2 asserts the `src` attribute survives intact (not just that the iframe tag survives — the verification checks the post-sanitize DOM and confirms the original `youtu.be` URL is preserved). |
| `srcdoc` attribute smuggling - an author writes `<iframe src="..." srcdoc="...">` to inject arbitrary HTML on an allowlisted host. | `srcdoc` is **not** in the iframe attribute allowlist. Test case #6 asserts this. |
| Multi-line iframe attributes evade the lint regex. | Catalog grep on 2026-06-22 found zero multi-line iframe attributes. If a future tutorial has one: lint silently misses it but sanitizer still strips it (the sanitizer parses HTML properly, not by regex). The worst case is a warning we should have shown did not show - not a security gap. |
| A non-author opens a PR with a malicious iframe. | All tutorial source PRs are reviewed by `sap-tutorials` maintainers; iframes never come from end-user input. This is the same trust model as every other tutorial-markdown element. |

## Out of scope

- **Backfilling the legacy AEM iframe-allowlist as comments in tutorial source.** Authors author markdown; the allowlist is platform infrastructure. Documenting in `iframe-allowlist.md` is sufficient.
- **`sandbox` attribute support.** If a tutorial ever genuinely needs an iframe with a relaxed sandbox, that is a separate design decision.
- **Inline-style iframe widths.** sanitize-html allows `class` attribute on every tag; authors who need responsive sizing can use a CSS class. Inline `style` would expand the attribute allowlist with a fresh risk surface.
