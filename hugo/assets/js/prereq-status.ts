// hugo/assets/js/prereq-status.ts
//
// Client-side hydration for prerequisite cards (.tut-prereq-card) and
// tutorial cross-reference links (.tut-xref).
//
// - Reads `data-slug` from each card/link.
// - Makes a single batched progress request for all slugs when the user
//   is authenticated (`document.documentElement.dataset.authenticated === 'true'`).
// - Updates each card's `.prereq-status` span and each xref link's
//   `data-complete` attribute for CSS styling.
// - Fails silently (no error surfaces to the reader).

const CAP_BASE = (document.documentElement as HTMLElement).dataset.capBase ?? ''
const _apiBase = (document.documentElement as HTMLElement).dataset.apiBase ?? '/api'
const API_BASE = _apiBase.startsWith('http') ? _apiBase : CAP_BASE + _apiBase

type ProgressStatus = 'completed' | 'in-progress' | 'not-started'

interface ProgressEntry {
  slug: string
  status: ProgressStatus
}

async function fetchBatchedProgress(slugs: string[]): Promise<Map<string, ProgressStatus>> {
  if (!slugs.length) return new Map()
  try {
    const params = new URLSearchParams({ slugs: slugs.join(',') })
    const res = await fetch(`${API_BASE}/user/progress?${params}`, { credentials: 'include' })
    if (!res.ok) return new Map()
    const entries = (await res.json()) as ProgressEntry[]
    return new Map(entries.map(e => [e.slug, e.status]))
  } catch {
    return new Map()
  }
}

function statusLabel(status: ProgressStatus | undefined): string {
  switch (status) {
    case 'completed': return '✓ Completed'
    case 'in-progress': return 'In progress'
    default: return 'Start'
  }
}

export async function hydratePrereqStatus(): Promise<void> {
  const authenticated =
    (document.documentElement as HTMLElement).dataset.authenticated === 'true'
  if (!authenticated) return

  // Collect slugs from prerequisite cards
  const cards = Array.from(document.querySelectorAll<HTMLElement>('.tut-prereq-card[data-slug]'))
  // Collect slugs from cross-reference links
  const xrefs = Array.from(document.querySelectorAll<HTMLElement>('.tut-xref[data-slug]'))

  const allSlugs = [
    ...new Set([
      ...cards.map(el => el.dataset.slug!),
      ...xrefs.map(el => el.dataset.slug!),
    ].filter(Boolean)),
  ]

  if (!allSlugs.length) return

  const progress = await fetchBatchedProgress(allSlugs)

  // Update prereq cards
  for (const card of cards) {
    const slug = card.dataset.slug!
    const status = progress.get(slug)
    const statusEl = card.querySelector<HTMLElement>('.prereq-status')
    if (statusEl) {
      statusEl.textContent = statusLabel(status)
      statusEl.dataset.status = status ?? 'not-started'
    }
  }

  // Update cross-reference links (tutorial refs in body text)
  for (const xref of xrefs) {
    const slug = xref.dataset.slug!
    const status = progress.get(slug)
    if (status) {
      xref.dataset.complete = status === 'completed' ? 'true' : 'false'
    }
  }
}

// Auto-initialize when the DOM is ready, but only on pages that have cards or xrefs
if (
  document.querySelectorAll('.tut-prereq-card[data-slug], .tut-xref[data-slug]').length > 0
) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { hydratePrereqStatus() })
  } else {
    hydratePrereqStatus()
  }
}
