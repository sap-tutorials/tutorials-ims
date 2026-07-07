/**
 * Static action registry for the command palette.
 *
 * Each action is keyword-matched on `keywords + label` so users can find them
 * by intent ("dark", "theme") without remembering exact wording. Tutorial
 * search results are layered on top at runtime — they don't live here.
 *
 * The `run` function executes when the action is selected. It receives the
 * dialog-close callback so actions can dismiss the palette before performing
 * navigation/side-effects (avoids visual flicker of palette during transition).
 *
 * Actions are tagged with a `group` so the palette can render them under
 * distinct headings (ACTIONS vs EXPLORE). The order below is the display
 * order within each group when the filter is empty. Issue #817 added the
 * EXPLORE group covering the homepage verb-spine + the Knowledge Graph
 * Explorer — those routes are otherwise reachable only from the homepage's
 * primary nav and were missing from ⌘K.
 */
export type PaletteGroup = 'actions' | 'explore'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  icon?: string
  keywords?: string[]
  /** Display group. Defaults to 'actions' when omitted. */
  group?: PaletteGroup
  /** Tutorial slug — present only on rows produced by searchTutorials. */
  slug?: string
  run: (close: () => void) => void
}

function copyCurrentUrl(close: () => void) {
  const url = window.location.href
  const done = () => {
    close()
    // Tiny toast — reuse the share-popover status pattern conceptually but
    // without dependence on it. A console hint is fine; users see the URL is
    // already on the clipboard via the OS notification on most platforms.
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(done, done)
  } else {
    const tmp = document.createElement('input')
    tmp.value = url
    document.body.appendChild(tmp)
    tmp.select()
    try { document.execCommand('copy') } catch {}
    tmp.remove()
    done()
  }
}

function toggleTheme(close: () => void) {
  const html = document.documentElement
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark'
  html.dataset.theme = next
  html.classList.toggle('dark', next === 'dark')
  try { localStorage.setItem('theme', next) } catch {}
  // The shellbar header.html has its own theme toggle that updates the icon —
  // when the user reaches for ⌘K instead of clicking the moon, we still want
  // the shellbar icon to reflect reality. Fire a synthetic click on the
  // existing handler if available; otherwise the theme is set on <html> and
  // CSS reacts immediately, which is the only thing that matters visually.
  const themeItem = document.getElementById('sb-theme') as HTMLElement | null
  if (themeItem) themeItem.setAttribute('icon', next === 'dark' ? 'light-mode' : 'dark-mode')
  close()
}

function openJoule(close: () => void) {
  close()
  // joule.js exposes `window.joule.open()` — attached synchronously (before
  // its async config load resolves) with an internal _pendingOpen queue, so
  // it's safe to call whether or not the panel bootstrap has finished.
  // Fallback: flip the panel's `hidden` attribute directly (the partial uses
  // the HTML `hidden` boolean, not `open`) so ⌘K still opens *something*
  // when joule.js failed to load — better than a silent no-op.
  const j = (window as unknown as { joule?: { open?: (opts?: unknown) => void } }).joule
  if (j && typeof j.open === 'function') {
    j.open()
    return
  }
  const panel = document.getElementById('joule-panel') as HTMLElement | null
  if (panel) panel.hidden = false
}

function navTo(href: string) {
  return (close: () => void) => {
    close()
    window.location.href = href
  }
}

export const PALETTE_ACTIONS: PaletteAction[] = [
  {
    id: 'go-home',
    label: 'Go to tutorials home',
    icon: 'home',
    keywords: ['home', 'browse', 'catalog', 'index'],
    run: navTo('/'),
  },
  {
    id: 'go-progress',
    label: 'Go to my completions',
    icon: 'complete',
    keywords: ['progress', 'completions', 'profile', 'me'],
    run: navTo('/me'),
  },
  {
    id: 'open-joule',
    label: 'Open Joule chat',
    icon: 'discussion-2',
    keywords: ['joule', 'ai', 'chat', 'assistant', 'help', 'ask'],
    run: openJoule,
  },
  {
    id: 'toggle-theme',
    label: 'Toggle light / dark theme',
    icon: 'palette',
    keywords: ['theme', 'dark', 'light', 'mode', 'color'],
    run: toggleTheme,
  },
  {
    id: 'copy-url',
    label: 'Copy page URL',
    icon: 'copy',
    keywords: ['url', 'link', 'share', 'clipboard'],
    run: copyCurrentUrl,
  },
  {
    id: 'report-issue',
    label: 'Report an issue with this page',
    icon: 'write-new-document',
    keywords: ['issue', 'bug', 'feedback', 'report', 'github'],
    run: (close) => {
      const slug = document.documentElement.dataset.pageSlug || ''
      const title = document.documentElement.dataset.pageTitle || document.title
      close()
      const url = `https://github.com/sap-tutorials/Tutorials/issues/new?title=${encodeURIComponent(title)}${slug ? `&body=Slug:%20${encodeURIComponent(slug)}` : ''}`
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  },

  // EXPLORE group — the 7 homepage verb-spine routes, three curated
  // destinations (Concepts, Devtoberfest, Developer Advocates — #1036),
  // and the Knowledge Graph Explorer. Order matches the verb-spine partial
  // at hugo/layouts/partials/homepage/verb-spine.html (LEARN, BUILD,
  // INTEGRATE, MODEL, OPERATE, AI, CONNECT). Keep the verb list in sync if
  // the spine ever gains an eighth verb; otherwise the palette will be out
  // of date with the homepage's own primary nav.
  {
    id: 'explore-learn',
    label: 'Learn — getting started with SAP for developers',
    icon: 'learning-assistant',
    keywords: ['learn', 'learning', 'getting started', 'beginner', 'fundamentals', 'onboard', 'verb'],
    group: 'explore',
    run: navTo('/learn/'),
  },
  {
    id: 'explore-build',
    label: 'Build — apps and services (CAP, ABAP Cloud, Fiori, UI5)',
    icon: 'wrench',
    keywords: ['build', 'cap', 'abap', 'fiori', 'ui5', 'app', 'service', 'verb'],
    group: 'explore',
    run: navTo('/build/'),
  },
  {
    id: 'explore-integrate',
    label: 'Integrate — connect SAP to non-SAP, APIs, events',
    icon: 'chain-link',
    keywords: ['integrate', 'integration', 'api', 'events', 'connectivity', 'destination', 'verb'],
    group: 'explore',
    run: navTo('/integrate/'),
  },
  {
    // (#1029) MODEL — data-platform verb: HANA Cloud, Datasphere, Business
    // Data Cloud, SAP Analytics Cloud. CAP CDS stays under BUILD.
    id: 'explore-model',
    label: 'Model — HANA Cloud, Datasphere, Business Data Cloud, SAC',
    icon: 'database',
    keywords: ['model', 'data', 'hana', 'datasphere', 'bdc', 'business data cloud', 'sac', 'analytics', 'calc view', 'semantic', 'verb'],
    group: 'explore',
    run: navTo('/model/'),
  },
  {
    id: 'explore-operate',
    label: 'Operate — deploy, run, secure, govern on BTP',
    icon: 'shield',
    keywords: ['operate', 'deploy', 'run', 'btp', 'security', 'govern', 'devops', 'verb'],
    group: 'explore',
    run: navTo('/operate/'),
  },
  {
    id: 'explore-ai',
    label: 'Extend with AI — Joule, AI Core, ground-truth patterns',
    icon: 'da',
    keywords: ['ai', 'joule', 'ai core', 'genai', 'ml', 'agent', 'verb'],
    group: 'explore',
    run: navTo('/ai/'),
  },
  {
    id: 'explore-connect',
    label: 'Connect — events, advocates, community',
    icon: 'group',
    keywords: ['connect', 'community', 'events', 'advocates', 'codejam', 'devtoberfest', 'verb'],
    group: 'explore',
    run: navTo('/connect/'),
  },
  {
    id: 'explore-concepts',
    label: 'Concepts — index of every SAP concept in the knowledge graph',
    icon: 'bullet-text',
    keywords: ['concepts', 'index', 'glossary', 'terms', 'kg', 'knowledge'],
    group: 'explore',
    run: navTo('/concepts/'),
  },
  {
    id: 'explore-devtoberfest',
    label: 'Devtoberfest — annual SAP developer festival',
    icon: 'calendar',
    keywords: ['devtoberfest', 'festival', 'event', 'weekly', 'challenge', 'october'],
    group: 'explore',
    run: navTo('/devtoberfest/'),
  },
  {
    id: 'explore-advocates',
    label: 'Developer Advocates — meet the SAP DevRel team',
    icon: 'group',
    keywords: ['advocates', 'devrel', 'team', 'spokespeople', 'community', 'evangelists'],
    group: 'explore',
    run: navTo('/developer-advocates/'),
  },
  {
    id: 'explore-knowledge-graph',
    label: 'Knowledge Graph Explorer',
    icon: 'org-chart',
    keywords: ['knowledge graph', 'kg', 'graph', 'concepts', 'map', 'network', 'explore', 'visualization'],
    group: 'explore',
    run: navTo('/explore/'),
  },
]

/**
 * Step-jump actions are page-aware and rebuilt every time the palette opens.
 * Returns [] on non-tutorial pages.
 */
export function buildStepActions(): PaletteAction[] {
  if (document.documentElement.dataset.pageKind !== 'tutorial') return []
  const steps = Array.from(document.querySelectorAll<HTMLElement>('.tutorial-step[id^="step-"]'))
  return steps.map((step) => {
    const num = step.id.replace(/^step-/, '')
    const heading = step.querySelector<HTMLElement>('h2, .step-title, .step-heading')
    const title = heading?.textContent?.trim() || `Step ${num}`
    return {
      id: `step-${num}`,
      label: `Jump to step ${num}: ${title}`,
      icon: 'arrow-right',
      keywords: ['step', 'jump', `step ${num}`],
      run: (close) => {
        close()
        step.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }
  })
}
