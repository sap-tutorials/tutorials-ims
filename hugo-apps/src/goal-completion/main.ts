// Headless Group/Mission completion decorator (#2733 redesign).
//
// Detail pages are server-rendered and cached per-slug (shared across users),
// so per-user completion state is applied client-side. This island fetches the
// signed-in user's completed-tutorial set once and decorates the numbered
// tutorial markers (green ✓ circle, matching tutorial-page step markers) and
// each group header ("N of M complete"). Anonymous users / no progress leave
// the page's plain numbers untouched. Fail-open on any error.

import { decorateMarkers } from './decorate'

async function run() {
  // Only act when the page actually carries the island mount (mission/group
  // detail pages). The mount node itself renders nothing now.
  const mount = document.querySelector('[data-vue-island="goal-completion"]')
  if (!mount) return

  let json: any
  try {
    const res = await fetch('/build/my-progress', { credentials: 'include' })
    if (!res.ok) return // fail-open
    json = await res.json()
  } catch {
    return // fail-open
  }
  if (!json?.authenticated) return // anonymous: leave plain numbers

  const raw = json?.tutorials?.completedSlugs
  const completed: string[] = Array.isArray(raw) ? raw.filter((s: unknown) => typeof s === 'string') : []
  if (completed.length === 0) return // nothing completed: nothing to mark

  decorateMarkers(document, completed)
}

run()
