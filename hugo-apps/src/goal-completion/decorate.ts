// hugo-apps/src/goal-completion/decorate.ts
//
// Decorate a Group/Mission detail page with per-user completion state, inline
// on the numbered tutorial markers and in each group header — mirroring the
// tutorial-page step markers (green ✓ circle) rather than a standalone bar.
//
// Pure DOM mutation driven by the user's completed-slug set. Framework-free and
// idempotent so it is trivially unit-testable with happy-dom and safe to run
// once per island mount.
//
// Markup contract (stamped by packages/content/catalog-renderer.js):
//   <span class="tutorial-number" data-slug="abap-create-project">1</span>
//   <span class="group-completion" data-group-slugs='["a","b"]'></span>

import { goalCompletion } from '../shared/goalCompletion'

const CHECK = '✓'; // ✓

/**
 * Mark each `.tutorial-number[data-slug]` whose slug is in `completedSlugs` as
 * completed (green ✓ circle), and fill each `.group-completion[data-group-slugs]`
 * with "N of M complete" (+ a ✓ at 100%). Slugs are matched case-insensitively
 * (tutorial slugs are lowercase-canonical). Returns a small summary for tests.
 */
export function decorateMarkers(
  root: ParentNode,
  completedSlugs: Iterable<string>,
): { tutorialsMarked: number; groupsLabeled: number } {
  const completed = new Set(Array.from(completedSlugs, (s) => String(s).toLowerCase()));

  // Per-tutorial numbered markers. Mission pages use `.tutorial-number`,
  // group-body pages use `.timeline-circle` — both carry data-slug.
  let tutorialsMarked = 0;
  const markers = root.querySelectorAll<HTMLElement>(
    '.tutorial-number[data-slug], .timeline-circle[data-slug]',
  );
  for (const el of Array.from(markers)) {
    const slug = (el.getAttribute('data-slug') || '').toLowerCase();
    const isDone = !!slug && completed.has(slug);
    el.classList.toggle('completed', isDone);
    if (isDone) {
      // Replace the number glyph with a check; keep the real number for a11y.
      if (!el.hasAttribute('data-number')) el.setAttribute('data-number', el.textContent || '');
      el.textContent = CHECK;
      el.setAttribute('aria-label', `Tutorial ${el.getAttribute('data-number')}: completed`);
      tutorialsMarked++;
    } else if (el.hasAttribute('data-number')) {
      // Idempotent restore if re-run after a reset.
      el.textContent = el.getAttribute('data-number') || el.textContent;
      el.removeAttribute('aria-label');
    }
  }

  // Per-group "N of M complete" + ✓ when whole group is done.
  let groupsLabeled = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.group-completion[data-group-slugs]'))) {
    let slugs: string[] = [];
    try {
      const parsed = JSON.parse(el.getAttribute('data-group-slugs') || '[]');
      if (Array.isArray(parsed)) slugs = parsed.filter((s) => typeof s === 'string');
    } catch { slugs = []; }
    if (slugs.length === 0) continue;
    const g = goalCompletion(slugs, completed);
    el.classList.toggle('group-completion--complete', g.complete);
    el.textContent = g.complete
      ? `${CHECK} ${g.completed} of ${g.total} complete`
      : `${g.completed} of ${g.total} complete`;
    groupsLabeled++;
  }

  return { tutorialsMarked, groupsLabeled };
}
