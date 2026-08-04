# Tutorial Video Embed Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make embedded tutorial videos render in the new tutorial system — fix the parser that silently drops pre-step content (the reported bug, 20 tutorials), and add an optional `video:` frontmatter slot plus Vimeo/`<video>` support.

**Architecture:** A new `extractIntro` parser captures content between the recognized header blocks and the first step, which `renderHugoFrontmatter` emits as a `{{% tutorial-intro %}}` passthrough shortcode (goldmark `unsafe=true` renders the raw iframe). A separate `normalizeVideo` parser + `video:` frontmatter drives a styled player partial. The sanitizer and approuter CSP gain Vimeo + `<video>` support.

**Tech Stack:** TypeScript (Node parsers, ESM, `.js` import specifiers), Vitest, Hugo (goldmark + shortcodes/partials), `sanitize-html`, PostCSS, esbuild (parsers bundle).

**Spec:** `docs/superpowers/specs/2026-08-04-tutorial-video-embed-design.md`

## Global Constraints

- **Import specifiers use `.js` extensions** even for `.ts` source (ESM/NodeNext), e.g. `import { x } from './video.js'`. Match existing parser files.
- **Three-file sync rule** (`sanitize-html.ts:35-38`): any iframe-host allowlist change updates `scripts/parsers/sanitize-html.ts`, `approuter/xs-app.json`, and `docs/developers/reference/iframe-allowlist.md` together.
- **The parsers bundle is generated, never hand-edited**: `srv-qa/lib/parsers.bundle.mjs` is produced by `npm run prebuild:parsers-bundle` (esbuild). Regenerate it; do not edit it directly.
- **Fence-awareness**: any parser scanning for `###`/`<iframe>` must skip fenced code blocks (reuse `createFenceTracker` from `./fence-tracker.js`).
- **`normalizeVideo` never emits a broken embed**: unrecognized host/shape → return `null` + `console.warn(slug)`; no `video` frontmatter emitted.
- **Windows line endings**: normalize LF at boundaries; the pipeline already calls `normalizeLineEndings` before parsing.
- **Commit frequently**; feature branch only, never `main`. PR for review (never direct-merge).

---

## Task 1: `normalizeVideo` parser + types

**Files:**
- Create: `scripts/parsers/video.ts`
- Modify: `scripts/parsers/types.ts` (add `NormalizedVideo` type + `video?` on `TutorialFrontmatter`)
- Test: `scripts/__tests__/video.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `interface NormalizedVideo { embedUrl: string; title: string; provider: 'youtube' | 'vimeo' | 'opensap' | 'sapvideo' }`
  - `function normalizeVideo(input: unknown, slug: string): NormalizedVideo | null`
  - `TutorialFrontmatter.video?: { url?: string; title?: string; provider?: string } | string`

**Behavior:**
- Accept an object `{ url, title?, provider? }`. Also accept a bare string (treated as `url`) for author convenience.
- Resolve `embedUrl` + `provider` from the URL/id:
  - YouTube watch (`https://www.youtube.com/watch?v=<id>`), short (`https://youtu.be/<id>`), already-embed (`https://www.youtube.com/embed/<id>`), or bare 11-char id `[A-Za-z0-9_-]{11}` → `https://www.youtube.com/embed/<id>`, provider `youtube`.
  - Vimeo (`https://vimeo.com/<digits>` or `https://player.vimeo.com/video/<digits>`) → `https://player.vimeo.com/video/<digits>`, provider `vimeo`.
  - openSAP (`https://microlearning.opensap.com/...`) → pass URL through, provider `opensap`.
  - sapvideo (`https://sapvideo.cfapps.eu10-004.hana.ondemand.com/...`) → pass through, provider `sapvideo`.
  - Anything else → `console.warn(\`[video] ${slug}: unrecognized video url/host: ${...}\`)` and return `null`.
- `title` defaults to `'Video tutorial'` when absent/empty.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/__tests__/video.test.ts
import { describe, it, expect, vi } from 'vitest'
import { normalizeVideo } from '../parsers/video.js'

describe('normalizeVideo', () => {
  it('normalizes a YouTube watch URL', () => {
    expect(normalizeVideo({ url: 'https://www.youtube.com/watch?v=6WY70LyLS1c' }, 's')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c',
      title: 'Video tutorial',
      provider: 'youtube',
    })
  })
  it('normalizes a youtu.be short URL and keeps a title', () => {
    expect(normalizeVideo({ url: 'https://youtu.be/6WY70LyLS1c', title: 'Intro' }, 's')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c', title: 'Intro', provider: 'youtube',
    })
  })
  it('accepts a bare 11-char YouTube id', () => {
    expect(normalizeVideo('6WY70LyLS1c', 's')?.embedUrl).toBe('https://www.youtube.com/embed/6WY70LyLS1c')
  })
  it('normalizes a Vimeo URL', () => {
    expect(normalizeVideo({ url: 'https://vimeo.com/123456789' }, 's')).toEqual({
      embedUrl: 'https://player.vimeo.com/video/123456789', title: 'Video tutorial', provider: 'vimeo',
    })
  })
  it('passes through an openSAP microlearning URL', () => {
    const r = normalizeVideo({ url: 'https://microlearning.opensap.com/media/x/1_abc' }, 's')
    expect(r?.provider).toBe('opensap')
    expect(r?.embedUrl).toContain('microlearning.opensap.com')
  })
  it('returns null and warns for an unknown host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeVideo({ url: 'https://evil.example/x' }, 'my-slug')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('my-slug'))
    warn.mockRestore()
  })
  it('returns null for empty/missing input', () => {
    expect(normalizeVideo(undefined, 's')).toBeNull()
    expect(normalizeVideo({}, 's')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/video.test.ts`
Expected: FAIL — `Cannot find module '../parsers/video.js'`.

- [ ] **Step 3: Implement `scripts/parsers/video.ts`**

```typescript
import type { NormalizedVideo } from './types.js'

const YT_ID = /^[A-Za-z0-9_-]{11}$/

function extractYouTubeId(u: URL | null, raw: string): string | null {
  if (YT_ID.test(raw)) return raw
  if (!u) return null
  const host = u.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0]
    return YT_ID.test(id) ? id : null
  }
  if (host === 'youtube.com') {
    if (u.pathname === '/watch') { const v = u.searchParams.get('v'); return v && YT_ID.test(v) ? v : null }
    const m = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)
    if (m) return m[1]
  }
  return null
}

export function normalizeVideo(input: unknown, slug: string): NormalizedVideo | null {
  let url = ''
  let title = ''
  if (typeof input === 'string') url = input.trim()
  else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    url = typeof o.url === 'string' ? o.url.trim() : ''
    title = typeof o.title === 'string' ? o.title.trim() : ''
  }
  if (!url) return null
  if (!title) title = 'Video tutorial'

  let parsed: URL | null = null
  try { parsed = new URL(url) } catch { parsed = null }

  const ytId = extractYouTubeId(parsed, url)
  if (ytId) return { embedUrl: `https://www.youtube.com/embed/${ytId}`, title, provider: 'youtube' }

  if (parsed) {
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const m = parsed.pathname.match(/(\d+)/)
      if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, title, provider: 'vimeo' }
    }
    if (parsed.hostname === 'microlearning.opensap.com') {
      return { embedUrl: url, title, provider: 'opensap' }
    }
    if (parsed.hostname === 'sapvideo.cfapps.eu10-004.hana.ondemand.com') {
      return { embedUrl: url, title, provider: 'sapvideo' }
    }
  }

  console.warn(`[video] ${slug}: unrecognized video url/host: ${url}`)
  return null
}
```

Add to `scripts/parsers/types.ts` (near `TutorialFrontmatter`):

```typescript
export interface NormalizedVideo {
  embedUrl: string
  title: string
  provider: 'youtube' | 'vimeo' | 'opensap' | 'sapvideo'
}
```

And add the optional source field inside the existing `TutorialFrontmatter` interface:

```typescript
  /**
   * Optional author-supplied intro video. Object `{ url, title?, provider? }`
   * or a bare URL/id string. Normalized by scripts/parsers/video.ts →
   * emitted as the `video` Hugo frontmatter object. Unrecognized hosts are
   * dropped (warn) rather than rendered as a broken frame.
   */
  video?: { url?: string; title?: string; provider?: string } | string
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/video.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/video.ts scripts/parsers/types.ts scripts/__tests__/video.test.ts
git commit -m "feat(video): normalizeVideo parser for tutorial video frontmatter"
```

---

## Task 2: `extractIntro` parser (pre-step passthrough)

**Files:**
- Create: `scripts/parsers/intro.ts`
- Test: `scripts/__tests__/intro.test.ts`

**Interfaces:**
- Consumes: `createFenceTracker` from `./fence-tracker.js`.
- Produces: `function extractIntro(body: string, isV2: boolean): string`

**Behavior:**
- Input is the processed body (post image/option/branch passes), same string handed to `parseV2Steps`/`parseV1Steps`.
- Return the trimmed content that sits **before the first step delimiter**, with these recognized blocks removed (they already flow to frontmatter):
  - the `# Title` line (first H1)
  - the `<!-- description -->` line
  - the `## You will learn` section (heading through the line before the next `##`/`###`/step)
  - the `## Prerequisites` section (same rule)
- Step delimiter: v2 → first non-fenced `/^### /`; v1 → first `[ACCORDION-BEGIN [Step N: ](url)]`.
- Fence-aware: a `###` inside a ```` ``` ```` fence is not a delimiter.
- If nothing remains after removal (only whitespace), return `''`.
- Preserve remaining section headings (e.g. `## Video Version`) and their content verbatim, including raw HTML iframes.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/__tests__/intro.test.ts
import { describe, it, expect } from 'vitest'
import { extractIntro } from '../parsers/intro.js'

const V2 = `# Create a UI

<!-- description --> Do the thing.

## You will learn

- How to A
- How to B

## Prerequisites

- You did the previous tutorial

## Video Version

Video tutorial version:

<iframe width="560" height="315" src="https://www.youtube.com/embed/6WY70LyLS1c" allowfullscreen></iframe>

### Run the services

1. Do it.
`

describe('extractIntro (v2)', () => {
  it('keeps the Video Version section with its iframe', () => {
    const intro = extractIntro(V2, true)
    expect(intro).toContain('## Video Version')
    expect(intro).toContain('6WY70LyLS1c')
    expect(intro).toContain('<iframe')
  })
  it('removes title, description, You will learn, Prerequisites', () => {
    const intro = extractIntro(V2, true)
    expect(intro).not.toContain('# Create a UI')
    expect(intro).not.toContain('description')
    expect(intro).not.toContain('You will learn')
    expect(intro).not.toContain('Prerequisites')
    expect(intro).not.toContain('How to A')
  })
  it('stops at the first step and excludes step content', () => {
    expect(extractIntro(V2, true)).not.toContain('Run the services')
    expect(extractIntro(V2, true)).not.toContain('Do it.')
  })
  it('returns empty string when there is no pre-step content', () => {
    const noIntro = `# T\n\n## Prerequisites\n\n- x\n\n### Step one\n\n1. go\n`
    expect(extractIntro(noIntro, true)).toBe('')
  })
  it('does not treat a fenced ### as a step boundary', () => {
    const fenced = `# T\n\n## Notes\n\n\`\`\`md\n### not a step\n\`\`\`\n\nkeep me\n\n### Real step\n\n1. go\n`
    const intro = extractIntro(fenced, true)
    expect(intro).toContain('### not a step')
    expect(intro).toContain('keep me')
    expect(intro).not.toContain('Real step')
  })
})

describe('extractIntro (v1)', () => {
  it('captures content before the first ACCORDION step', () => {
    const v1 = `# T\n\n## Video Version\n\n<iframe src="https://youtu.be/abcdef12345"></iframe>\n\n[ACCORDION-BEGIN [Step 1: ](Do)]\nbody\n[ACCORDION-END]\n`
    const intro = extractIntro(v1, false)
    expect(intro).toContain('## Video Version')
    expect(intro).not.toContain('ACCORDION')
    expect(intro).not.toContain('body')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/intro.test.ts`
Expected: FAIL — `Cannot find module '../parsers/intro.js'`.

- [ ] **Step 3: Implement `scripts/parsers/intro.ts`**

```typescript
import { createFenceTracker } from './fence-tracker.js'

const V1_STEP = /\[ACCORDION-BEGIN \[Step \d+:\s*\]\(.+?\)\]/

/**
 * Extract the content that sits before the first tutorial step, minus the
 * blocks already lifted into frontmatter (# Title, <!-- description -->,
 * ## You will learn, ## Prerequisites). Everything else — notably a
 * `## Video Version` section with a raw <iframe> — is preserved verbatim so
 * the Hugo build can render it above the steps. Root cause of the dropped-
 * video bug: parseV2Steps only collects content AFTER the first `### `.
 */
export function extractIntro(body: string, isV2: boolean): string {
  const lines = body.split('\n')
  const fence = createFenceTracker()

  // 1. Find the first step-delimiter line index (fence-aware).
  let firstStep = lines.length
  for (let i = 0; i < lines.length; i++) {
    const inFence = fence(lines[i])
    if (inFence) continue
    if (isV2 ? /^### /.test(lines[i]) : V1_STEP.test(lines[i])) { firstStep = i; break }
  }

  const pre = lines.slice(0, firstStep)

  // 2. Remove recognized blocks. A "section" runs from its `## Heading` up to
  //    the next `## `/`### ` heading (or end of pre-step region).
  const out: string[] = []
  let skipSectionUntilHeading = false
  for (let i = 0; i < pre.length; i++) {
    const line = pre[i]
    const isHeading = /^#{2,3} /.test(line)
    if (skipSectionUntilHeading) {
      if (isHeading) skipSectionUntilHeading = false
      else continue
    }
    if (/^# /.test(line)) continue                        // H1 title
    if (/<!--\s*description\s*-->/.test(line)) continue    // description marker line
    if (/^## (You will learn|Prerequisites)\s*$/.test(line)) {
      skipSectionUntilHeading = true
      continue
    }
    out.push(line)
  }

  return out.join('\n').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/intro.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/intro.ts scripts/__tests__/intro.test.ts
git commit -m "feat(intro): extractIntro preserves pre-step content (video sections)"
```

---

## Task 3: Sanitizer — add Vimeo host + `<video>`/`<source>`/`<track>`

**Files:**
- Modify: `scripts/parsers/sanitize-html.ts`
- Test: `scripts/__tests__/sanitize-html.test.ts` (add cases; file already exists)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ALLOWED_IFRAME_HOSTNAMES` now includes `player.vimeo.com`, `vimeo.com`. `stripDangerousHtml` now preserves `<video>`/`<source>`/`<track>` with a narrow attr allowlist.

- [ ] **Step 1: Write the failing test**

Append to `scripts/__tests__/sanitize-html.test.ts`:

```typescript
import { stripDangerousHtml } from '../parsers/sanitize-html.js'

describe('video + vimeo support', () => {
  it('preserves a <video> element with controls and <source>', () => {
    const out = stripDangerousHtml('<video controls width="640"><source src="https://raw.githubusercontent.com/x/y/clip.mp4" type="video/mp4"></video>')
    expect(out).toContain('<video')
    expect(out).toContain('controls')
    expect(out).toContain('<source')
    expect(out).toContain('clip.mp4')
  })
  it('strips onerror/onload from <video>', () => {
    const out = stripDangerousHtml('<video controls onerror="alert(1)" src="https://raw.githubusercontent.com/x/y/c.mp4"></video>')
    expect(out).not.toContain('onerror')
  })
  it('preserves a Vimeo player iframe', () => {
    const out = stripDangerousHtml('<iframe src="https://player.vimeo.com/video/123456789"></iframe>')
    expect(out).toContain('player.vimeo.com/video/123456789')
  })
  it('still drops an off-allowlist iframe host', () => {
    const out = stripDangerousHtml('<iframe src="https://evil.example/x"></iframe>')
    expect(out).not.toContain('evil.example')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/sanitize-html.test.ts -t "video + vimeo"`
Expected: FAIL — `<video>`/`<source>` stripped, Vimeo iframe dropped.

- [ ] **Step 3: Modify `scripts/parsers/sanitize-html.ts`**

Extend the host allowlist (`ALLOWED_IFRAME_HOSTNAMES`, ~line 42):

```typescript
export const ALLOWED_IFRAME_HOSTNAMES = [
  'www.youtube.com',
  'youtube.com',
  'youtu.be',
  'microlearning.opensap.com',
  'sapvideo.cfapps.eu10-004.hana.ondemand.com',
  'player.vimeo.com',
  'vimeo.com',
] as const
```

Add the media tags to `ALLOWED_TAGS` (~line 119):

```typescript
const ALLOWED_TAGS = [...SEMANTIC_TAGS, 'iframe', 'video', 'source', 'track']
```

Add per-tag attributes to `ALLOWED_ATTRS` (~line 121-134):

```typescript
  video: ['controls', 'width', 'height', 'poster', 'preload', 'loop', 'muted', 'playsinline', 'src'],
  source: ['src', 'type'],
  track: ['kind', 'src', 'srclang', 'label', 'default'],
```

Note: `video`/`source`/`track` are already in `KNOWN_HTML_TAGS` (line 76) so `escapePseudoTags` leaves them for sanitize-html to handle — now they survive because they're on `ALLOWED_TAGS`. `allowedSchemesAppliedToAttributes` already includes `src`, so `<source src>`/`<video src>` schemes are vetted. No `transformTags` hook needed for these (they aren't host-gated like iframe).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/sanitize-html.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/sanitize-html.ts scripts/__tests__/sanitize-html.test.ts
git commit -m "feat(sanitize): allow <video>/<source>/<track> and Vimeo iframes"
```

---

## Task 4: Wire `intro` + `video` through compose → render

**Files:**
- Modify: `scripts/parsers/compose.ts` (call `extractIntro`, add `intro` to `ComposeResult`)
- Modify: `scripts/parsers/render-frontmatter.ts` (accept `intro` + `video`, emit both)
- Modify: `scripts/parsers/index.ts` (export `normalizeVideo`, `extractIntro` for the bundle)
- Test: `scripts/__tests__/render-frontmatter.test.ts` (create if absent) and `scripts/__tests__/compose-intro.test.ts`

**Interfaces:**
- Consumes: `extractIntro` (Task 2), `normalizeVideo` + `NormalizedVideo` (Task 1), `stripDangerousHtml` (existing).
- Produces:
  - `ComposeResult.intro: string`
  - `RenderHugoFrontmatterArgs.intro?: string`
  - `RenderHugoFrontmatterArgs.video?: NormalizedVideo | null`
  - Rendered body now begins with an optional `{{% tutorial-intro %}}…{{% /tutorial-intro %}}` block; frontmatter gains an optional `video` object.

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/__tests__/compose-intro.test.ts
import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../parsers/compose.js'
import { renderHugoFrontmatter } from '../parsers/render-frontmatter.js'

const SRC = `---
parser: v2
time: 20
author_name: T
author_profile: https://github.com/t
tags: [tutorial>beginner]
primary_tag: products>x
---

# Create a UI

<!-- description --> Do the thing.

## Prerequisites

- prior tutorial

## Video Version

<iframe width="560" height="315" src="https://www.youtube.com/embed/6WY70LyLS1c" allowfullscreen></iframe>

### Run the services

1. Do it.
`

describe('compose + render intro passthrough', () => {
  it('composeTutorial returns the intro with the iframe', () => {
    const c = composeTutorial(SRC, { repo: 'r', branch: 'b', slug: 's', target: 'hugo', rewriteImages: false })
    expect(c.intro).toContain('6WY70LyLS1c')
    expect(c.intro).toContain('## Video Version')
  })
  it('renderHugoFrontmatter emits a tutorial-intro shortcode with the iframe', () => {
    const c = composeTutorial(SRC, { repo: 'r', branch: 'b', slug: 's', target: 'hugo', rewriteImages: false })
    const md = renderHugoFrontmatter({
      slug: 's', title: c.title, description: c.description, time: 20, level: c.level,
      tags: ['tutorial>beginner'], primaryTag: 'products>x', author: 'T', authorProfile: '',
      youWillLearn: c.youWillLearn, prerequisites: c.prerequisites, steps: c.steps,
      nav: { slug: 's', title: '', description: '', time: 20, level: 'beginner', stepCount: c.steps.length, primaryTag: '', displayTags: [], displayTagSlugs: [], prev: null, next: null },
      lastUpdated: '', createdAt: '', contributors: [], intro: c.intro,
    })
    expect(md).toContain('{{% tutorial-intro %}}')
    expect(md).toContain('6WY70LyLS1c')
    expect(md.indexOf('{{% tutorial-intro %}}')).toBeLessThan(md.indexOf('{{% tutorial-step'))
  })
  it('emits a video frontmatter object when video: is set', () => {
    const md = renderHugoFrontmatter({
      slug: 's', title: 'T', description: '', time: 20, level: 'beginner',
      tags: [], primaryTag: '', author: 'T', authorProfile: '',
      youWillLearn: [], prerequisites: '', steps: [{ number: 1, title: 'A', content: 'x' }],
      nav: { slug: 's', title: '', description: '', time: 20, level: 'beginner', stepCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [], prev: null, next: null },
      lastUpdated: '', createdAt: '', contributors: [],
      video: { embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c', title: 'Intro', provider: 'youtube' },
    })
    expect(md).toContain('embedUrl: https://www.youtube.com/embed/6WY70LyLS1c')
    expect(md).toContain('provider: youtube')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/compose-intro.test.ts`
Expected: FAIL — `c.intro` undefined; no `tutorial-intro` in output.

- [ ] **Step 3: Modify the three source files**

In `scripts/parsers/compose.ts`:
- Add import: `import { extractIntro } from './intro.js'`
- Add `intro: string` to the `ComposeResult` interface.
- After the `const steps = isV2 ? parseV2Steps(v2Body) : parseV1Steps(processedBody)` line, compute the intro from the same body the parser saw:

```typescript
  const intro = extractIntro(isV2 ? v2Body : processedBody, isV2)
```

- Add `intro,` to the returned object.

In `scripts/parsers/render-frontmatter.ts`:
- Add import: `import type { NormalizedVideo } from './types.js'`
- Add to `RenderHugoFrontmatterArgs`:

```typescript
  /** Pre-step passthrough content (e.g. a `## Video Version` iframe) captured
   *  by extractIntro. Emitted as a {{% tutorial-intro %}} shortcode above the
   *  steps. Sanitized like step content. */
  intro?: string
  /** Optional styled video slot, already normalized by normalizeVideo. */
  video?: NormalizedVideo | null
```

- Destructure `intro` and `video` from `args`.
- After building `fm` (before the `frontmatter` string is created), emit the video object:

```typescript
  if (video) fm.video = { embedUrl: video.embedUrl, title: video.title, provider: video.provider }
```

- Build the intro block and prepend it to the steps markdown:

```typescript
  const introMd = intro && intro.trim()
    ? `{{% tutorial-intro %}}\n\n${escapeHugoDelimiters(stripDangerousHtml(intro, { allowDataUrls }))}\n\n{{% /tutorial-intro %}}\n\n`
    : ''

  const content = `${frontmatter}${introMd}${stepsMd}\n`
```

(Replace the existing `const content = ...` line.)

In `scripts/parsers/index.ts`:

```typescript
export { composeTutorial } from './compose.js'
export { renderHugoFrontmatter } from './render-frontmatter.js'
export { normalizeVideo } from './video.js'
export { extractIntro } from './intro.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/compose-intro.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/compose.ts scripts/parsers/render-frontmatter.ts scripts/parsers/index.ts scripts/__tests__/compose-intro.test.ts
git commit -m "feat: thread intro passthrough + video frontmatter through compose/render"
```

---

## Task 5: Wire `fetch-tutorials.ts` write path

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (`writeHugoPage` signature + call site; normalize `video` from frontmatter)
- Test: manual regeneration check (Task 8 covers end-to-end)

**Interfaces:**
- Consumes: `composeTutorial` (now returns `intro`), `normalizeVideo` (Task 1).
- Produces: `writeHugoPage` passes `intro` + `video` to `renderHugoFrontmatter`.

**Note on parameter style:** `writeHugoPage` uses a long positional parameter list. Adding two positional params at the end (`intro`, `video`) keeps the change minimal and matches the existing style — do NOT refactor to an options object (out of scope, would touch the VitePress caller path).

- [ ] **Step 1: Add `intro` + `video` params to `writeHugoPage`**

In `scripts/fetch-tutorials.ts`, add an import near the other parser imports (line ~18):

```typescript
import { normalizeVideo } from './parsers/video.js'
```

Extend the `writeHugoPage` signature (after `hasOsOptions: boolean = false,`, ~line 476):

```typescript
  hasOsOptions: boolean = false,
  intro: string = '',
  video: import('./parsers/types.js').NormalizedVideo | null = null,
```

Add both into the `renderHugoFrontmatter({ ... })` call (after `hasOsOptions,`, ~line 497):

```typescript
    hasOsOptions,
    intro,
    video,
```

- [ ] **Step 2: Pass `intro` + normalized `video` at the call site**

At the `writeHugoPage(...)` call (~line 982-1003), add two arguments after `composed.hasOsOptions,`:

```typescript
          composed.hasOsOptions,
          composed.intro,
          normalizeVideo(frontmatter.video, t.slug),
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json` (or the project's typecheck script — check `jq '.scripts.typecheck // .scripts["check:types"]' package.json`; if none, `npx tsc --noEmit`).
Expected: no new type errors from these files.

- [ ] **Step 4: Regenerate one tutorial and inspect**

```bash
rm -f .tutorial-cache/hana-cloud-cap-create-ui.md
npx tsx scripts/fetch-tutorials.ts --target hugo --slug hana-cloud-cap-create-ui 2>&1 | tail -5 || \
npx tsx scripts/fetch-tutorials.ts --target hugo 2>&1 | tail -5
grep -n '6WY70LyLS1c\|tutorial-intro' hugo/content/tutorials/hana-cloud-cap-create-ui.md
```

Expected: the generated file now contains `{{% tutorial-intro %}}` and the `6WY70LyLS1c` iframe. (Check `fetch-tutorials.ts` for the exact single-slug flag via `grep -n "slug" scripts/fetch-tutorials.ts` if `--slug` isn't supported; fall back to a full `--target hugo` run.)

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-tutorials.ts
git commit -m "feat: pass intro + normalized video into Hugo page write path"
```

---

## Task 6: Hugo shortcode + partial + styling

**Files:**
- Create: `hugo/layouts/shortcodes/tutorial-intro.html`
- Create: `hugo/layouts/partials/tutorial-video.html`
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (render video partial at top of Steps)
- Modify: `hugo/layouts/tutorials/single.html` (same, if it's a live layout — verify)
- Modify: `hugo/assets/css/sap-fundamental.css` (`.tutorial-intro`, `.tutorial-video` responsive 16:9)

**Interfaces:**
- Consumes: `.Params.video` (`{ embedUrl, title, provider }`) from Task 4/5; `.Inner` of the intro shortcode.
- Produces: rendered intro passthrough + styled player.

- [ ] **Step 1: Create the intro shortcode**

`hugo/layouts/shortcodes/tutorial-intro.html`:

```html
{{/* Pre-step passthrough content (e.g. a "## Video Version" iframe) captured
     by scripts/parsers/intro.ts. Percent shortcode → .Inner is rendered
     through goldmark (unsafe=true), so a raw <iframe> renders. */}}
<div class="tutorial-intro">{{ .Inner }}</div>
```

- [ ] **Step 2: Create the video partial**

`hugo/layouts/partials/tutorial-video.html`:

```html
{{/* Styled intro video player from the optional `video:` frontmatter object
     ({ embedUrl, title, provider }). Rendered above the steps. Renders nothing
     when .Params.video is absent. YouTube/Vimeo/openSAP/sapvideo are iframe
     embeds; provider is informational. */}}
{{ with .Params.video }}
<div class="tutorial-video" data-provider="{{ .provider }}">
  <div class="tutorial-video__frame">
    <iframe src="{{ .embedUrl }}" title="{{ .title }}" loading="lazy"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen></iframe>
  </div>
</div>
{{ end }}
```

- [ ] **Step 3: Render the video partial in the object page**

In `hugo/layouts/tutorials/u1-object-page.html`, inside the Steps `<section>`, immediately before `<div class="tutorial-steps">{{ .Content }}</div>` (line ~335), add:

```html
          {{ partial "tutorial-video.html" . }}
          <div class="tutorial-steps">{{ .Content }}</div>
```

Check `hugo/layouts/tutorials/single.html` — if it is still a served layout (it also has `<div class="tutorial-steps">{{ .Content }}</div>` at :31), add the same partial line there. If it's dead/legacy, skip (verify via `grep -rn "single.html\|u1-object-page" hugo/hugo.toml hugo/config`).

- [ ] **Step 4: Add CSS**

Append to `hugo/assets/css/sap-fundamental.css` (near the `.step-content` rules, ~line 1148, or at end of the tutorial section):

```css
/* Intro passthrough + styled video slot (tutorial video embeds). */
.tutorial-intro {
  margin: 0 0 1.5rem;
}
.tutorial-intro iframe {
  max-width: 100%;
  aspect-ratio: 16 / 9;
  width: 100%;
  height: auto;
  border: 0;
  border-radius: 0.5rem;
}
.tutorial-video {
  margin: 0 0 1.5rem;
}
.tutorial-video__frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 0.5rem;
  overflow: hidden;
  background: #000;
}
.tutorial-video__frame iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
```

- [ ] **Step 5: Build CSS + Hugo, verify render, commit**

```bash
npm run build:css
npm run dev   # or: npx hugo --source hugo --destination hugo/public --quiet
```

Then load `http://localhost:1313/tutorials/hana-cloud-cap-create-ui/` in a browser and confirm the YouTube video renders between Prerequisites and Step 1. (This is the real-thing check — do not rely on grep alone.)

```bash
git add hugo/layouts/shortcodes/tutorial-intro.html hugo/layouts/partials/tutorial-video.html hugo/layouts/tutorials/u1-object-page.html hugo/layouts/tutorials/single.html hugo/assets/css/sap-fundamental.css hugo/static/css/sap-fundamental.css
git commit -m "feat(hugo): render tutorial intro passthrough + styled video player"
```

---

## Task 7: CSP (approuter) + docs allowlist

**Files:**
- Modify: `approuter/xs-app.json` (CSP `frame-src` += Vimeo; add `media-src`)
- Modify: `docs/developers/reference/iframe-allowlist.md`

**Interfaces:** none (config + docs). Must stay in sync with Task 3's `ALLOWED_IFRAME_HOSTNAMES` (three-file rule).

- [ ] **Step 1: Update the CSP header value**

In `approuter/xs-app.json` (the `Content-Security-Policy` header, line ~6):
- In `frame-src`, append ` https://player.vimeo.com https://vimeo.com` after the existing `sapvideo...ondemand.com`.
- Add a `media-src` directive (currently absent) so `<video src>` is not blocked by `default-src 'self'`. Insert after the `frame-src` directive:

```
media-src 'self' https://raw.githubusercontent.com;
```

Resulting `frame-src` reads:
`frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com https://player.vimeo.com https://vimeo.com;`

- [ ] **Step 2: Validate the JSON**

Run: `npx jsonlint approuter/xs-app.json || node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('valid')"`
Expected: `valid` (no parse error).

- [ ] **Step 3: Update the docs allowlist table**

In `docs/developers/reference/iframe-allowlist.md`, add rows for `player.vimeo.com` and `vimeo.com`, and a note that `<video>` elements are supported with `media-src 'self' https://raw.githubusercontent.com`. Match the existing table format (read the file first).

- [ ] **Step 4: Commit**

```bash
git add approuter/xs-app.json docs/developers/reference/iframe-allowlist.md
git commit -m "feat(csp): allow Vimeo frame-src + media-src for <video>; sync docs"
```

---

## Task 8: Preview parity + bundle regen + full-suite gate

**Files:**
- Modify: `srv-qa/preview-renderer.js` (pass `video` through; `intro` flows automatically via render-frontmatter, but wire `video` from composed frontmatter)
- Regenerate: `srv-qa/lib/parsers.bundle.mjs` (via npm script)
- Verify: `.deploy/mta.yaml` srv-qa `cp` list (no new transitive dep expected, but audit)

**Interfaces:**
- Consumes: `composeTutorial` (returns `intro`), `normalizeVideo` (bundle now exports it via index.ts).

- [ ] **Step 1: Thread `video` through the preview renderer**

In `srv-qa/preview-renderer.js`, import `normalizeVideo` from the bundle and pass it into `renderHugoFrontmatter`. Update the import (line 7):

```javascript
import { composeTutorial, renderHugoFrontmatter, normalizeVideo } from './lib/parsers.bundle.mjs';
```

Add to the `renderHugoFrontmatter({ ... })` args (after `allowDataUrls: true,`, ~line 111):

```javascript
      video: normalizeVideo(composed.frontmatter?.video, '__preview__'),
```

(`intro` is produced inside `renderHugoFrontmatter` only when passed; the preview must also pass it — add `intro: composed.intro,` to the same args object.)

- [ ] **Step 2: Regenerate the bundle**

Run: `npm run prebuild:parsers-bundle`
Expected: `srv-qa/lib/parsers.bundle.mjs` rewritten with `normalizeVideo`/`extractIntro` included. Confirm: `grep -c "normalizeVideo\|extractIntro" srv-qa/lib/parsers.bundle.mjs` returns ≥ 2.

- [ ] **Step 3: Audit the srv-qa cp list**

Run: `grep -nE "parsers|srv/lib" .deploy/mta.yaml | head`
The new files (`video.ts`, `intro.ts`) are bundled INTO `parsers.bundle.mjs` by esbuild, so they are NOT separate runtime deps — no `cp` entry needed. Confirm `srv-qa/lib/parsers.bundle.mjs` is already in the cp list (it is the compiled artifact). Note in the commit if nothing changed.

- [ ] **Step 4: Run the full parser + preview test suites**

```bash
npx vitest run scripts/__tests__/ test/srv-qa/preview-renderer.test.js
```
Expected: all green, including pre-existing sanitize-html and preview tests (regen bundle must not break them).

- [ ] **Step 5: Commit**

```bash
git add srv-qa/preview-renderer.js srv-qa/lib/parsers.bundle.mjs
git commit -m "feat(preview): intro + video parity in author preview; regen parsers bundle"
```

---

## Task 9: End-to-end verification + lint

**Files:** none (verification task).

- [ ] **Step 1: Full regenerate + spot-check the 20 pre-step-video tutorials**

```bash
npm run fetch-tutorials -- --regenerate 2>&1 | tail -10
# hana-cloud-cap-create-ui + a couple more from the pre-step bucket:
for s in hana-cloud-cap-create-ui; do grep -c 'tutorial-intro\|youtube.com/embed' "hugo/content/tutorials/$s.md"; done
```

Expected: each shows the intro shortcode + embed present.

- [ ] **Step 2: Build + browser-verify (Tom's #1 rule)**

```bash
npm run build:css && npm run build:hugo 2>&1 | tail -5
```
Load `hana-cloud-cap-create-ui` in a browser (dev server or built `hugo/public`), confirm the video plays between Prerequisites and Step 1, and that an in-step video tutorial (`build-apps-s4hana-crud`) still renders.

- [ ] **Step 3: Lint the parser markdown rules**

Run: `npx tsx scripts/lint-tutorial-markdown.ts 2>&1 | tail -20` (or the project lint script — `jq '.scripts | to_entries[] | select(.key|test("lint"))' package.json`).
Expected: no new failures introduced by Vimeo/host changes. The `iframe-non-allowlisted-host` rule imports `ALLOWED_IFRAME_HOSTNAMES`, so Vimeo now passes automatically.

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Open PR**

```bash
git push -u origin <feature-branch>
gh pr create --fill --title "feat: tutorial video embed support (pre-step passthrough + video frontmatter)"
```

Include in the PR body: root cause (parser dropped pre-step content), the two mechanisms, the three-file CSP sync, and the post-deploy follow-up (migrate one tutorial to `video:` frontmatter).

---

## Post-deploy follow-up (not in this plan, per Tom)

After deploy, migrate ONE of the 20 tutorials' source markdown (in `sap-tutorials`) from the raw `## Video Version` iframe to the new `video: { url, title }` frontmatter, to validate path B end-to-end. Separate PR against the source repo.

## Self-Review notes

- **Spec coverage:** Gap 1 (pre-step drop) → Tasks 2,4,5,6. Gap 2 (sanitizer/CSP) → Tasks 3,7. Frontmatter slot → Tasks 1,4,5,6. Preview parity → Task 8. Verification → Task 9. All spec sections mapped.
- **Type consistency:** `NormalizedVideo { embedUrl, title, provider }` defined in Task 1, consumed identically in Tasks 4,5,6,8. `extractIntro(body, isV2)` defined Task 2, called Task 4. `writeHugoPage` positional params extended in Task 5 match the render args in Task 4.
- **No placeholders:** all code steps carry real code; verification steps carry real commands with fallbacks where a flag needs confirming.
