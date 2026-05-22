// hugo/assets/js/nav-progress.ts
//
// U14: branded top-of-viewport progress indicator for full-page navigations.
// Trickles 0 → 30 → ~90 on internal-link click; jumps to 100 and hides on
// pagehide. Aborts back to hidden if no navigation actually happens within
// 100 ms (hash-only or JS-prevented click).

type Ui5ProgressIndicator = HTMLElement & { value: number }

const TRICKLE_INTERVAL_MS = 250
const TRICKLE_STEP_MIN = 1
const TRICKLE_STEP_MAX = 5
const TRICKLE_CEILING = 90
const ABORT_GRACE_MS = 100

function el(): Ui5ProgressIndicator | null {
  return document.getElementById('nav-progress') as Ui5ProgressIndicator | null
}

let trickleTimer: number | null = null
let abortTimer: number | null = null

function clearTimers() {
  if (trickleTimer !== null) { clearInterval(trickleTimer); trickleTimer = null }
  if (abortTimer !== null) { clearTimeout(abortTimer); abortTimer = null }
}

function show() {
  clearTimers()
  const bar = el()
  if (!bar) return
  bar.value = 0
  bar.hidden = false
  // jump quickly to 30, then trickle.
  requestAnimationFrame(() => { bar.value = 30 })
  trickleTimer = window.setInterval(() => {
    if (bar.value >= TRICKLE_CEILING) return
    const step = TRICKLE_STEP_MIN + Math.random() * (TRICKLE_STEP_MAX - TRICKLE_STEP_MIN)
    bar.value = Math.min(TRICKLE_CEILING, bar.value + step)
  }, TRICKLE_INTERVAL_MS)
}

function complete() {
  const bar = el()
  if (!bar) return
  clearTimers()
  bar.value = 100
  // brief hold, then fade. Timing is generous because pagehide may fire just
  // before the new document replaces this one.
  setTimeout(() => { bar.hidden = true; bar.value = 0 }, 50)
}

function abort() {
  const bar = el()
  if (!bar) return
  clearTimers()
  bar.hidden = true
  bar.value = 0
}

function isInternalNavigation(a: HTMLAnchorElement, e: MouseEvent): boolean {
  if (e.defaultPrevented) return false
  if (e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  const target = a.getAttribute('target')
  if (target && target !== '_self') return false
  if (a.hasAttribute('download')) return false
  const href = a.getAttribute('href')
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false
  try {
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin) return false
    // same-page hash navigation: do not show the bar.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return false
    return true
  } catch {
    return false
  }
}

export function initNavProgress() {
  if (!el()) return // partial not present (shouldn't happen, but guard anyway)

  // Click delegation. Use bubbling phase so other handlers (hash links) get
  // first say.
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    const a = target?.closest('a[href]') as HTMLAnchorElement | null
    if (!a) return
    if (!isInternalNavigation(a, e as MouseEvent)) return

    // Defer to ensure the element is registered before mutating `value`.
    customElements.whenDefined('ui5-progress-indicator').then(() => {
      show()
      // Grace timer: if visibility hides AND no pagehide arrived, abort.
      // Some clicks get cancelled synchronously after this handler returns
      // (form submits intercepted, JS-driven SPA detours we don't know about).
      abortTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') abort()
      }, ABORT_GRACE_MS)
    })
  })

  // Capture phase: pagehide fires before the document is torn down. We
  // intentionally use the default `once` behaviour — pagehide can fire more
  // than once across bfcache restores, and complete() is idempotent.
  window.addEventListener('pagehide', () => complete(), { capture: true })
  // beforeunload as a fallback for the rare browsers that skip pagehide.
  window.addEventListener('beforeunload', () => complete())

  // bfcache restore: reset visible state.
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) abort()
  })
}

initNavProgress()
