// --- Mermaid diagrams with Horizon palette ---
// Lazy-loads mermaid only when a diagram is on the page; re-themes on dark/light toggle.

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void
  run: (opts?: { querySelector?: string; nodes?: ArrayLike<HTMLElement> }) => Promise<void>
}

let mermaidApi: MermaidApi | null = null
let initialized = false

function readPalette(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => (cs.getPropertyValue(name).trim() || fallback)
  const brand = v('--sapBrandColor', '#0070f2')
  const text = v('--sapTextColor', '#1d2d3e')
  const label = v('--sapContent_LabelColor', '#556b82')
  const border = v('--sapContent_ForegroundBorderColor', '#89919a')
  const bg = v('--sapBackgroundColor', '#f5f6f7')
  const tile = v('--sapTile_Background', '#ffffff')
  const success = v('--sapSuccessColor', '#188918')
  const warning = v('--sapWarningColor', '#e76500')
  const error = v('--sapErrorColor', '#aa0808')

  return {
    primaryColor: tile,
    primaryTextColor: text,
    primaryBorderColor: brand,
    secondaryColor: bg,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: bg,
    tertiaryTextColor: label,
    tertiaryBorderColor: border,
    lineColor: border,
    textColor: text,
    background: 'transparent',
    mainBkg: tile,
    nodeBorder: brand,
    clusterBkg: bg,
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: bg,
    actorBkg: tile,
    actorBorder: brand,
    actorTextColor: text,
    actorLineColor: border,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: bg,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: brand,
    activationBorderColor: brand,
    noteBkgColor: bg,
    noteBorderColor: border,
    noteTextColor: text,
    errorBkgColor: error,
    errorTextColor: tile,
    successBkgColor: success,
    warningBkgColor: warning,
  }
}

function mermaidConfig() {
  return {
    startOnLoad: false,
    theme: 'base',
    themeVariables: readPalette(),
    flowchart: { curve: 'basis', useMaxWidth: true },
    sequence: { useMaxWidth: true, mirrorActors: false },
    fontFamily: '"72", "72full", Arial, Helvetica, sans-serif',
  }
}

async function loadAndRender() {
  if (!mermaidApi) {
    const mod = await import('mermaid')
    mermaidApi = (mod.default || mod) as MermaidApi
  }
  mermaidApi.initialize(mermaidConfig())
  initialized = true
  await renderVisible()
}

function isVisible(el: HTMLElement): boolean {
  // offsetParent is null when the element or any ancestor has display:none / hidden
  return el.offsetParent !== null && el.getBoundingClientRect().width > 1
}

async function renderVisible() {
  if (!mermaidApi) return
  const pending: HTMLElement[] = []
  document.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])').forEach((el) => {
    if (isVisible(el)) pending.push(el)
  })
  if (pending.length) await mermaidApi.run({ nodes: pending })
}

function watchVisibility() {
  // Re-check pending diagrams whenever a step toggles or layout shifts.
  const handler = () => { void renderVisible() }
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null
    if (t && t.closest('[data-action="toggle-step"]')) {
      // Step body unhide is synchronous; defer to next frame for layout.
      requestAnimationFrame(handler)
    }
  })
  // Also handle "expand all" + hashchange-driven step expansion.
  window.addEventListener('hashchange', () => requestAnimationFrame(handler))
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => requestAnimationFrame(handler))
    document.querySelectorAll('.step-body').forEach((b) => {
      mo.observe(b, { attributes: true, attributeFilter: ['hidden'] })
    })
  }
}

async function rerender() {
  if (!mermaidApi) return
  // Reset processed nodes so mermaid re-runs them with the new palette
  document.querySelectorAll<HTMLElement>('.mermaid').forEach((el) => {
    const src = el.dataset.mermaidSource
    if (src !== undefined) {
      el.removeAttribute('data-processed')
      el.textContent = src
    }
  })
  mermaidApi.initialize(mermaidConfig())
  await renderVisible()
}

function captureSources() {
  document.querySelectorAll<HTMLElement>('.mermaid').forEach((el) => {
    if (el.dataset.mermaidSource === undefined) {
      el.dataset.mermaidSource = el.textContent || ''
    }
  })
}

function watchTheme() {
  let scheduled = false
  const observer = new MutationObserver(() => {
    if (!initialized || scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      void rerender()
    })
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  })
}

export function initMermaid() {
  if (!document.querySelector('.mermaid')) return
  captureSources()
  watchTheme()
  watchVisibility()
  void loadAndRender()
}
