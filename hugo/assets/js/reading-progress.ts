// U11: top-of-viewport reading-progress bar + step scrollspy.
// Lives in ui5-bootstrap.ts's import graph so it runs on every page; both
// helpers early-exit when their target DOM is absent.
//
// Why two side-effects from one module:
//  - The progress bar gates on `.tutorial-steps` being present.
//  - The scrollspy gates on `.tutorial-step` items being present.
//  - Demo pages and real tutorial pages both render those nodes, so a single
//    shared module covers both cases without duplicating init wiring.
//
// Coordination with tutorial.ts: when scrollspy initializes, it sets
// document.documentElement.dataset.scrollspy = 'active'. tutorial.ts's
// expand-based updateActiveTocItem() checks that attribute and bails so the
// two don't fight over .step-toc-item.active.

function initReadingProgress() {
  const stepsRoot = document.querySelector<HTMLElement>('.tutorial-steps')
  const bar = document.getElementById('reading-progress')
  if (!stepsRoot || !bar) return
  bar.hidden = false

  function update() {
    if (!stepsRoot || !bar) return
    const rect = stepsRoot.getBoundingClientRect()
    const winH = window.innerHeight
    // distance scrolled through the section while it overlaps the viewport.
    const total = Math.max(1, rect.height - winH)
    const scrolled = -rect.top
    const pct = Math.max(0, Math.min(1, scrolled / total))
    bar.style.setProperty('--scroll-progress', `${(pct * 100).toFixed(2)}%`)
    const inView = rect.top < winH && rect.bottom > 0
    if (inView) bar.setAttribute('data-active', '')
    else bar.removeAttribute('data-active')
  }

  let raf = 0
  function onScroll() {
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; update() })
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })
  update()
}

function initStepScrollspy() {
  const steps = Array.from(document.querySelectorAll<HTMLElement>('.tutorial-step'))
  if (!steps.length) return
  document.documentElement.dataset.scrollspy = 'active'

  const ACTIVE_BAND = 200 // px from top of viewport — clears the sticky op-header.

  function pickActive(): HTMLElement | null {
    let best: { el: HTMLElement; dist: number } | null = null
    for (const step of steps) {
      const r = step.getBoundingClientRect()
      if (r.bottom <= 0 || r.top >= window.innerHeight) continue
      const dist = Math.abs(r.top - ACTIVE_BAND)
      if (!best || dist < best.dist) best = { el: step, dist }
    }
    return best?.el ?? null
  }

  let lastActive: string | null = null
  function applyActive() {
    const active = pickActive()
    const stepNum = active?.dataset.step ?? null
    if (stepNum === lastActive) return
    lastActive = stepNum
    document.querySelectorAll('.step-toc-item').forEach(item => item.classList.remove('active'))
    if (stepNum) {
      const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
      if (tocItem) tocItem.classList.add('active')
    }
  }

  let raf = 0
  function onScroll() {
    if (raf) return
    raf = requestAnimationFrame(() => { raf = 0; applyActive() })
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll, { passive: true })

  // IO is a wake-up only — the rAF check above does the actual selection.
  const io = new IntersectionObserver(onScroll, { threshold: [0, 0.25, 0.5, 0.75, 1] })
  steps.forEach(s => io.observe(s))

  applyActive()
}

function init() {
  initReadingProgress()
  initStepScrollspy()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
