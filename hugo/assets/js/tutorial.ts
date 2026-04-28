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

// Stub function referenced in event delegation (implemented in later task)
function markDone(_btn: HTMLButtonElement) {}
