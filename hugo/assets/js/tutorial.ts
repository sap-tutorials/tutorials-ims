import { initMermaid } from './mermaid-bootstrap'

// --- Copy code block ---
;(window as any).copyCodeBlock = function(btn: HTMLButtonElement) {
  const block = btn.closest('.code-block')
  if (!block) return
  const code = block.querySelector('.code-block-body code, .code-block-body pre')
  if (!code) return
  const text = code.textContent || ''
  navigator.clipboard.writeText(text).then(() => {
    const label = btn.querySelector('.copy-label')
    if (label) {
      label.textContent = 'Copied!'
      setTimeout(() => { label.textContent = 'Copy' }, 2000)
    }
  })
}

// Event delegation
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const stepLink = target.closest('a[href^="#step-"]') as HTMLAnchorElement | null
  if (stepLink) {
    const m = stepLink.getAttribute('href')!.match(/^#step-(\d+)$/)
    if (m) expandStep(m[1])
  }
  const stepHeader = target.closest('[data-action="toggle-step"]')
  if (stepHeader) { toggleStep(stepHeader as HTMLElement); return }
  const doneBtn = target.closest('[data-action="mark-done"]')
  if (doneBtn) { markDone(doneBtn as HTMLButtonElement); return }
  const tabBtn = target.closest('[role="tab"]')
  if (tabBtn) { switchTab(tabBtn as HTMLButtonElement); return }
  const codeToggle = target.closest('[data-action="toggle-code"]')
  if (codeToggle) { toggleCodeBlock(codeToggle as HTMLButtonElement); return }
})

function toggleCodeBlock(btn: HTMLButtonElement) {
  const block = btn.closest('.code-block')
  if (!block) return
  const body = block.querySelector('.code-block-body') as HTMLElement | null
  if (!body) return
  const expanded = btn.getAttribute('aria-expanded') === 'true'
  if (expanded) {
    body.dataset.collapsed = 'true'
    btn.setAttribute('aria-expanded', 'false')
  } else {
    delete body.dataset.collapsed
    btn.setAttribute('aria-expanded', 'true')
  }
}

function toggleStep(header: HTMLElement) {
  const step = header.closest('.tutorial-step')
  if (!step) return
  const body = step.querySelector('.step-body') as HTMLElement
  if (!body) return
  const icon = step.querySelector('.step-toggle-icon')
  body.hidden = !body.hidden
  if (icon) icon.textContent = body.hidden ? '+' : '—'
  updateActiveTocItem()
}

function expandStep(stepNum: string): HTMLElement | null {
  const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`) as HTMLElement | null
  if (!step) return null
  const body = step.querySelector('.step-body') as HTMLElement | null
  if (!body) return step
  if (body.hidden) {
    body.hidden = false
    const icon = step.querySelector('.step-toggle-icon')
    if (icon) icon.textContent = '—'
    updateActiveTocItem()
  }
  return step
}

function scrollToStepHash() {
  const m = location.hash.match(/^#step-(\d+)$/)
  if (!m) return
  const step = expandStep(m[1])
  if (step) step.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function initStepHashNavigation() {
  if (location.hash.startsWith('#step-')) scrollToStepHash()
  window.addEventListener('hashchange', scrollToStepHash)
}

function expandAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) body.hidden = false
    if (icon) icon.textContent = '—'
  })
  updateActiveTocItem()
}

function collapseAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) body.hidden = true
    if (icon) icon.textContent = '+'
  })
  updateActiveTocItem()
}

// --- Sidebar TOC active highlighting ---
// U11: when reading-progress.ts initializes scrollspy on a page, it sets
// documentElement.dataset.scrollspy='active'. We bail here so the two don't
// fight over .step-toc-item.active. The expand-based fallback below is kept
// for non-tutorial pages and as a pre-scroll initial paint on cold loads.
function updateActiveTocItem() {
  if (document.documentElement.dataset.scrollspy === 'active') return
  document.querySelectorAll('.step-toc-item').forEach(item => item.classList.remove('active'))
  const expandedStep = document.querySelector('.tutorial-step .step-body:not([hidden])')
  if (!expandedStep) return
  const step = expandedStep.closest('.tutorial-step')
  if (!step) return
  const stepNum = (step as HTMLElement).dataset.step
  if (stepNum) {
    const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
    if (tocItem) tocItem.classList.add('active')
  }
}

// Expose globally for onclick handlers in template
;(window as any).expandAllSteps = expandAllSteps
;(window as any).collapseAllSteps = collapseAllSteps

// --- Tab switching ---
function switchTab(btn: HTMLButtonElement) {
  const container = btn.closest('[data-component="tabs"]')
  if (!container) return
  const index = btn.dataset.tabIndex
  container.querySelectorAll('[role="tab"]').forEach(t => t.classList.remove('is-selected'))
  btn.classList.add('is-selected')
  container.querySelectorAll('[data-tab-panel]').forEach(p => {
    const panel = p as HTMLElement
    panel.hidden = panel.dataset.tabPanel !== index
  })
}

// --- API Helper ---
const CAP_BASE = document.documentElement.dataset.capBase || ''
const _apiBase = document.documentElement.dataset.apiBase || '/api'
const API_BASE = _apiBase.startsWith('http') ? _apiBase : CAP_BASE + _apiBase

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    return res.ok ? res.json() : null
  } catch { return null }
}

async function apiPost(path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch { return false }
}

// U14: flip data-hydrated on the documentElement once the progress fetch is
// settled (or after a 1.5s race timeout). Idempotent — the head.html tail
// fallback may have already done this; setting the same value is a no-op.
function markHydrated() {
  if (document.documentElement.dataset.hydrated === 'false') {
    document.documentElement.dataset.hydrated = 'true';
  }
}

// --- Progress tracking ---
function markButtonCompleted(btn: HTMLButtonElement) {
  btn.textContent = 'Completed'
  btn.disabled = true
  btn.classList.add('is-completed')
}

// U10: shared toast for step-completion feedback. Single instance lives in baseof.html.
type Ui5Toast = HTMLElement & { duration: number; show?: () => void }
function showStepToast(text: string, durationMs: number) {
  const toast = document.getElementById('step-toast') as Ui5Toast | null
  if (!toast) return
  toast.textContent = text
  toast.duration = durationMs
  // ui5-toast.show() is the upgraded-element API. On the first interaction the
  // esbuild bundle may not yet have registered the element — fall back to
  // whenDefined so a synthetic-fast-click (or test) doesn't throw.
  if (typeof toast.show === 'function') {
    toast.show()
  } else {
    customElements.whenDefined('ui5-toast').then(() => toast.show?.())
  }
}

// U10: persistent CTA injected once when all steps are complete.
// ui5-toast is text-only by design; the CTA lives inline so the link remains
// reachable after the toast auto-dismisses (~4s).
function showCompletionCta() {
  const stepsRoot = document.querySelector('.tutorial-steps')
  if (!stepsRoot || stepsRoot.querySelector('.tutorial-completion-cta')) return
  const strip = document.createElement('ui5-message-strip')
  strip.setAttribute('design', 'Positive')
  strip.className = 'tutorial-completion-cta'
  strip.appendChild(document.createTextNode('You’ve finished this tutorial. '))
  const link = document.createElement('a')
  link.href = '/tutorials/'
  link.textContent = 'Browse more tutorials →'
  strip.appendChild(link)
  stepsRoot.appendChild(strip)
}

async function markDone(btn: HTMLButtonElement) {
  const stepNum = btn.dataset.step
  if (!stepNum || btn.disabled) return
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  btn.disabled = true
  btn.textContent = 'Saving...'
  const ok = await apiPost(`/completeStep`, { slug, stepNumber: parseInt(stepNum, 10) })

  const step = btn.closest('.tutorial-step')
  if (ok && step) {
    step.classList.add('completed')
    const circle = step.querySelector('.step-check-circle')
    if (circle) circle.textContent = '✓'
    const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
    if (tocItem) tocItem.classList.add('completed')
    markButtonCompleted(btn)
    updateProgressBar()

    // U10: completion feedback. Final-step toast wins over the per-step toast.
    const total = document.querySelectorAll('.tutorial-step').length
    const completed = document.querySelectorAll('.tutorial-step.completed').length
    if (total > 0 && completed >= total) {
      showStepToast('🎉 Tutorial complete!', 4000)
      showCompletionCta()
    } else {
      const remaining = total - completed
      const tail = remaining === 1 ? '1 to go!' : `${remaining} to go!`
      showStepToast(`Step ${stepNum} complete — ${tail}`, 3000)
    }
  } else {
    btn.textContent = 'Done'
    btn.disabled = false
  }
}

function initProgressBar() {
  const container = document.getElementById('progress-bar')
  if (!container) return
  const count = parseInt(container.dataset.stepCount || '0', 10)
  if (count === 0) return

  const bar = document.createElement('div')
  bar.className = 'progress-segments'
  for (let i = 1; i <= count; i++) {
    const seg = document.createElement('div')
    seg.className = 'progress-segment'
    seg.dataset.step = String(i)
    bar.appendChild(seg)
  }
  container.appendChild(bar)

  const label = document.createElement('div')
  label.className = 'progress-label'
  label.textContent = `0 / ${count}`
  container.appendChild(label)
}

function updateProgressBar() {
  const completed = document.querySelectorAll('.tutorial-step.completed').length
  const total = document.querySelectorAll('.tutorial-step').length

  document.querySelectorAll('.progress-segment').forEach(seg => {
    const el = seg as HTMLElement
    const step = parseInt(el.dataset.step || '0', 10)
    el.classList.toggle('completed', step <= completed)
  })

  const label = document.querySelector('.progress-label')
  if (label) label.textContent = `${completed} / ${total}`

  if (total > 0 && completed >= total) maybeShowCompletedBanner(completed)
}

async function loadProgress() {
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  const data = await apiGet<{ completedSteps: number[] }>(`/getProgress(slug='${encodeURIComponent(slug)}')`)
  if (!data?.completedSteps) return

  for (const stepNum of data.completedSteps) {
    const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`)
    if (step) {
      step.classList.add('completed')
      const circle = step.querySelector('.step-check-circle')
      if (circle) circle.textContent = '✓'
      const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
      if (tocItem) tocItem.classList.add('completed')
      const btn = step.querySelector('[data-action="mark-done"]') as HTMLButtonElement | null
      if (btn) markButtonCompleted(btn)
    }
  }
  updateProgressBar()
  maybeShowCompletedBanner(data.completedSteps.length)
}

function maybeShowCompletedBanner(completedCount: number) {
  const total = document.querySelectorAll('.tutorial-step').length
  if (!total || completedCount < total) return
  const host = document.querySelector('.tutorial-banners')
  if (!host || host.querySelector('[data-banner="completed"]')) return
  const strip = document.createElement('ui5-message-strip')
  strip.setAttribute('design', 'Positive')
  strip.setAttribute('data-banner', 'completed')
  strip.textContent = 'You completed this tutorial. Nice work!'
  host.appendChild(strip)
}

// --- Validation quiz ---
interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
  correctAnswer: string
}

interface StepData {
  number: number
  title: string
  validation?: ValidationQuestion[]
}

function initValidation() {
  const dataEl = document.getElementById('tutorial-data')
  if (!dataEl) return
  let steps: StepData[]
  try {
    let parsed = JSON.parse(dataEl.textContent || '[]')
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    steps = parsed
  } catch { return }

  for (const step of steps) {
    if (!step.validation?.length) continue
    const mount = document.querySelector(`.step-validation-mount[data-step="${step.number}"]`)
    if (!mount) continue
    const doneBtn = document.querySelector(`button[data-action="mark-done"][data-step="${step.number}"]`) as HTMLButtonElement
    if (doneBtn) doneBtn.disabled = true
    renderQuiz(mount as HTMLElement, String(step.number), step.validation)
  }
}

function renderQuiz(mount: HTMLElement, stepNum: string, questions: ValidationQuestion[]) {
  const form = document.createElement('form')
  form.className = 'step-validation'
  form.dataset.step = stepNum

  questions.forEach((q, qi) => {
    const fieldset = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = q.question
    fieldset.appendChild(legend)

    if (q.type === 'multiple-choice' && q.options) {
      q.options.forEach((opt) => {
        const label = document.createElement('label')
        label.className = 'option-card'
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = `q-${stepNum}-${qi}`
        radio.value = opt
        label.appendChild(radio)
        const span = document.createElement('span')
        span.textContent = opt
        label.appendChild(span)
        fieldset.appendChild(label)
      })
    } else {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'fd-input'
      input.name = `q-${stepNum}-${qi}`
      input.placeholder = 'Type your answer...'
      fieldset.appendChild(input)
    }
    form.appendChild(fieldset)
  })

  const submitBtn = document.createElement('button')
  submitBtn.type = 'submit'
  submitBtn.className = 'fd-button'
  submitBtn.textContent = 'Submit Answer'
  form.appendChild(submitBtn)

  const feedback = document.createElement('div')
  feedback.className = 'validation-feedback'
  form.appendChild(feedback)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    handleQuizSubmit(form, stepNum, questions)
  })

  mount.appendChild(form)
}

function handleQuizSubmit(form: HTMLFormElement, stepNum: string, questions: ValidationQuestion[]) {
  const feedback = form.querySelector('.validation-feedback') as HTMLElement
  let allCorrect = true

  questions.forEach((q, qi) => {
    const name = `q-${stepNum}-${qi}`
    if (q.type === 'multiple-choice') {
      const selected = form.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null
      if (!selected || selected.value !== q.correctAnswer) allCorrect = false
    } else {
      const input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement | null
      if (!input || input.value.trim().toLowerCase() !== q.correctAnswer.toLowerCase()) allCorrect = false
    }
  })

  if (allCorrect) {
    feedback.textContent = 'Correct!'
    feedback.className = 'validation-feedback validation-success'
    const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`)
    if (step) step.setAttribute('data-validated', 'true')
    const doneBtn = step?.querySelector('[data-action="mark-done"]') as HTMLButtonElement | null
    if (doneBtn) doneBtn.disabled = false
  } else {
    feedback.textContent = 'Not quite. Try again!'
    feedback.className = 'validation-feedback validation-error'
  }
}

// --- Mini-navigator progress ---
async function initMiniNavProgress() {
  const nav = document.getElementById('mini-navigator-static')
  if (!nav) return
  const items = nav.querySelectorAll('.mini-nav-item')
  if (!items.length) return

  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  const groupSlug = document.documentElement.dataset.groupSlug
  if (!groupSlug) return

  const data = await apiGet<{ completedSlugs: string[] }>(`/groups/${groupSlug}/progress`)
  if (!data?.completedSlugs) return

  let completed = 0
  items.forEach(item => {
    const el = item as HTMLElement
    if (data.completedSlugs.includes(el.dataset.slug || '')) {
      el.classList.add('is-completed')
      completed++
    }
  })

  const total = items.length
  const fill = document.getElementById('mini-nav-progress-fill')
  const label = document.getElementById('mini-nav-progress-label')
  if (fill) fill.style.width = `${Math.round((completed / total) * 100)}%`
  if (label) label.textContent = `${completed}/${total} TASKS COMPLETED`
}

// --- Auth-aware button state ---
function initAuthAwareButtons() {
  const observer = new MutationObserver(() => {
    if (document.documentElement.dataset.authenticated === 'true') {
      enableDoneButtons()
      observer.disconnect()
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-authenticated'] })

  // If auth check completes before this runs
  if (document.documentElement.dataset.authenticated === 'true') {
    observer.disconnect()
    return
  }

  // Disable after a short delay to allow auth check to complete first
  setTimeout(() => {
    if (document.documentElement.dataset.authenticated !== 'true') {
      disableDoneButtons()
    }
  }, 1000)
}

function disableDoneButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="mark-done"]').forEach(btn => {
    if (btn.closest('.tutorial-step')?.querySelector('[data-validated="false"]')) return
    btn.disabled = true
    btn.title = 'Sign in to track your progress'
    btn.classList.add('is-auth-disabled')
  })
}

function enableDoneButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="mark-done"].is-auth-disabled').forEach(btn => {
    btn.disabled = false
    btn.title = ''
    btn.classList.remove('is-auth-disabled')
  })
}

// --- Init on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
  initProgressBar()
  // U14: race the real fetch against a 1.5s timeout so a slow or 401 response
  // does not strand users on shimmer. Both branches call markHydrated();
  // markHydrated() is idempotent.
  Promise.race([
    loadProgress().then(markHydrated, markHydrated),
    new Promise<void>((resolve) => setTimeout(() => { markHydrated(); resolve() }, 1500)),
  ])
  initValidation()
  updateActiveTocItem()
  initMiniNavProgress()
  initAuthAwareButtons()
  initStepHashNavigation()
  initMermaid()
})
