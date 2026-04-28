// Event delegation
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const stepHeader = target.closest('[data-action="toggle-step"]')
  if (stepHeader) { toggleStep(stepHeader as HTMLElement); return }
  const doneBtn = target.closest('[data-action="mark-done"]')
  if (doneBtn) { markDone(doneBtn as HTMLButtonElement); return }
  const tabBtn = target.closest('[role="tab"]')
  if (tabBtn) { switchTab(tabBtn as HTMLButtonElement); return }
})

function toggleStep(header: HTMLElement) {
  const step = header.closest('.tutorial-step')
  if (!step) return
  const body = step.querySelector('.step-body') as HTMLElement
  if (!body) return
  const icon = step.querySelector('.step-toggle-icon')
  body.hidden = !body.hidden
  if (icon) icon.textContent = body.hidden ? '+' : '—'
}

function expandAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) body.hidden = false
    if (icon) icon.textContent = '—'
  })
}

function collapseAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) body.hidden = true
    if (icon) icon.textContent = '+'
  })
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
const API_BASE = document.documentElement.dataset.apiBase || '/api'

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`)
    return res.ok ? res.json() : null
  } catch { return null }
}

async function apiPost(path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch { return false }
}

// --- Progress tracking ---
async function markDone(btn: HTMLButtonElement) {
  const stepNum = btn.dataset.step
  if (!stepNum || btn.disabled) return
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  btn.disabled = true
  btn.textContent = 'Saving...'
  const ok = await apiPost(`/tutorials/${slug}/steps/${stepNum}/complete`)

  const step = btn.closest('.tutorial-step')
  if (ok && step) {
    step.classList.add('completed')
    const circle = step.querySelector('.step-check-circle')
    if (circle) circle.textContent = '✓'
    const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
    if (tocItem) tocItem.classList.add('completed')
    updateProgressBar()
  }
  btn.textContent = 'Done'
  btn.disabled = false
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
}

async function loadProgress() {
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  const data = await apiGet<{ completedSteps: number[] }>(`/tutorials/${slug}/progress`)
  if (!data?.completedSteps) return

  for (const stepNum of data.completedSteps) {
    const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`)
    if (step) {
      step.classList.add('completed')
      const circle = step.querySelector('.step-check-circle')
      if (circle) circle.textContent = '✓'
      const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
      if (tocItem) tocItem.classList.add('completed')
    }
  }
  updateProgressBar()
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
  try { steps = JSON.parse(dataEl.textContent || '[]') } catch { return }

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

// --- Init on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
  initProgressBar()
  loadProgress()
  initValidation()
})
