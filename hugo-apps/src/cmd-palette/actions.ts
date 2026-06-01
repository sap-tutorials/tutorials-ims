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
 */
export interface PaletteAction {
  id: string
  label: string
  hint?: string
  icon?: string
  keywords?: string[]
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
  // joule-panel.html partial wires itself to a global toggle. If unavailable
  // we silently no-op — better than a broken-looking action.
  const fn = (window as unknown as { openJoulePanel?: () => void }).openJoulePanel
  if (typeof fn === 'function') fn()
  else {
    const panel = document.getElementById('joule-panel') as HTMLElement | null
    if (panel) panel.setAttribute('open', '')
  }
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
