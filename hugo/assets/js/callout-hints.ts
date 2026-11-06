// callout-hints.ts — progressive reveal for consecutive hint alerts
// Finds <details class="alert-hint"> groups within each .step-content.
// Requires: nothing (pure DOM).
// Called: DOMContentLoaded.

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll<HTMLElement>('.step-content').forEach(step => {
    const hints = [...step.querySelectorAll<HTMLDetailsElement>('details.alert-hint')]
    // Group consecutive hints (they must be adjacent siblings)
    const groups: HTMLDetailsElement[][] = []
    let group: HTMLDetailsElement[] = []
    for (const hint of hints) {
      if (group.length === 0 || hint.previousElementSibling === group[group.length - 1]) {
        group.push(hint)
      } else {
        if (group.length > 1) groups.push(group)
        group = [hint]
      }
    }
    if (group.length > 1) groups.push(group)

    // For each group, wire progressive reveal
    groups.forEach(g => {
      // Number the hints
      g.forEach((hint, i) => {
        const summary = hint.querySelector('summary')
        if (summary) summary.textContent = `Hint ${i + 1}`
      })
      // Disable hints 2..N
      for (let i = 1; i < g.length; i++) g[i].setAttribute('data-hint-disabled', '')
      // Wire open event
      for (let i = 0; i < g.length - 1; i++) {
        g[i].addEventListener('toggle', () => {
          if (g[i].open) g[i + 1].removeAttribute('data-hint-disabled')
        }, { once: true })
      }
    })
  })
})
