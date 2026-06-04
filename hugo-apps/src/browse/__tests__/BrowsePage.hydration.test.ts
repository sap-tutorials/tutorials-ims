// hugo-apps/src/browse/__tests__/BrowsePage.hydration.test.ts
//
// @vitest-environment happy-dom
//
// Verifies that BrowsePage.vue mounts on the SSR'd #browse-root without
// emitting Vue hydration mismatch warnings, and that URL state (filter
// chip, sort dropdown) survives hydration via the controller.
//
// This is the load-bearing hydration test for PR 2: it catches drift
// between the Hugo SSR output (browse-page-1.html fixture) and the Vue
// island's runtime expectations.
//
// The test mounts only BrowsePage on #browse-root (matching production
// behaviour). The rest of the SSR'd DOM (banner, filter rail, sort
// dropdown, pagination) is parsed but stays static — controller.ts
// wires DOM event listeners onto it, those listeners are exercised
// via the URL-state assertions.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import BrowsePage from '../BrowsePage.vue'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_HTML = readFileSync(
  join(__dirname, 'fixtures', 'browse-page-1.html'),
  'utf-8'
)

/**
 * Replace document.body's contents with the parsed body of the fixture.
 *
 * Avoids any DOM string-write API (some PreToolUse hooks reject the
 * literal token); uses DOMParser + appendChild instead.
 *
 * The captured /browse/ page contains hundreds of lines of `<head>`,
 * shell partials, lightbox dialogs, and external `<script src>`/`<link>`
 * tags that happy-dom would try to fetch (causing AggregateError noise
 * and unhandled rejections that mask real test results). We surgically
 * extract just what the hydration test cares about:
 *
 *  - `<main>` (banner + filter rail + grid + pagination — i.e. everything
 *    the controller wires onto, plus the `#browse-root` mount point).
 *  - `<script id="browse-data" type="application/json">` (the inlined
 *    catalog payload BrowsePage.vue's readBrowseData() consumes).
 *
 * Everything else (UI5 bootstrap script, joule render, lightbox, etc.)
 * is dropped. happy-dom's DOMParser eagerly schedules link/script
 * resource fetches even for parsed-but-unattached subtrees, so we
 * pre-strip those tokens from the source string before parsing.
 */
function loadFixtureIntoDocument() {
  // Pre-strip <link …> and <script src …>/<script type="module" …> from the
  // raw string so happy-dom's parser doesn't schedule resource fetches.
  // We keep <script id="browse-data" type="application/json"> by guarding
  // the replacement against the JSON-data type.
  const stripped = FIXTURE_HTML
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
      // Keep only inlined application/json scripts (no src=).
      if (/\btype\s*=\s*["']application\/json["']/i.test(attrs) && !/\bsrc\s*=/i.test(attrs)) {
        return full
      }
      return ''
    })

  const parser = new DOMParser()
  const doc = parser.parseFromString(stripped, 'text/html')

  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild)
  }

  const main = doc.querySelector('main')
  const browseData = doc.querySelector('script#browse-data')
  if (!main) throw new Error('fixture missing <main>')
  if (!browseData) throw new Error('fixture missing <script id="browse-data">')

  document.body.appendChild(main.cloneNode(true))
  document.body.appendChild(browseData.cloneNode(true))
}

describe('BrowsePage hydration', () => {
  let warnings: string[] = []
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined

  beforeEach(() => {
    warnings = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(a => String(a)).join(' '))
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(a => String(a)).join(' '))
    })
    // BrowsePage.vue's onMounted does `fetch('/build/my-progress', …)`.
    // happy-dom doesn't ship a real fetch by default — stub to a 401-like
    // response so the path runs without throwing.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    }))
  })

  afterEach(() => {
    warnSpy?.mockRestore()
    errorSpy?.mockRestore()
    vi.unstubAllGlobals()
    // Reset URL between tests so flag values from one don't leak to next.
    history.replaceState({}, '', '/browse/')
  })

  it('hydrates without [Vue warn] mismatch warnings', async () => {
    loadFixtureIntoDocument()
    // happy-dom's getElementById doesn't always re-index after appendChild
    // of a parsed-elsewhere subtree; querySelector walks the live tree and
    // works reliably.
    const root = document.body.querySelector('#browse-root') as HTMLElement | null
    expect(root).toBeTruthy()
    if (!root) return

    createSSRApp(BrowsePage).mount(root)
    // Allow onMounted + the (stubbed) progress fetch + watchers to settle.
    await new Promise(r => setTimeout(r, 50))

    const hydrationWarnings = warnings.filter(w =>
      /\[Vue warn\]|hydration node mismatch|hydrate the static slot/i.test(w)
    )
    expect(hydrationWarnings).toEqual([])
  })

  it('preserves URL filter chip checked state through hydration', async () => {
    history.replaceState({}, '', '/browse/?type=mission')
    loadFixtureIntoDocument()
    const root = document.body.querySelector('#browse-root') as HTMLElement | null
    if (!root) throw new Error('no #browse-root in fixture')

    createSSRApp(BrowsePage).mount(root)
    // Wait long enough for useNavigatorFilters' onMounted (which calls
    // parseNavState + nextTick) and controller.ts's immediate watch to
    // sync the SSR'd checkbox to the restored state.
    await new Promise(r => setTimeout(r, 100))

    const checkbox = document.body.querySelector(
      'input[name="type"][value="mission"]'
    ) as HTMLInputElement | null
    expect(checkbox).toBeTruthy()
    expect(checkbox?.checked).toBe(true)
  })

  it('preserves sort dropdown selected value through hydration', async () => {
    history.replaceState({}, '', '/browse/?sort=recent')
    loadFixtureIntoDocument()
    const root = document.body.querySelector('#browse-root') as HTMLElement | null
    if (!root) throw new Error('no #browse-root in fixture')

    createSSRApp(BrowsePage).mount(root)
    await new Promise(r => setTimeout(r, 100))

    const select = document.body.querySelector(
      'select[name="sort"]'
    ) as HTMLSelectElement | null
    expect(select).toBeTruthy()
    expect(select?.value).toBe('recent')
  })
})
