//
// Pure URL/label builder for the published-only QA + Live preview links
// surfaced on the admin Missions and Groups Object Pages (General tab).
// Spec: docs/superpowers/specs/2026-07-28-mission-group-preview-links-design.md
//
// Missions and Groups are served on the /tutorials/* route with a
// `mission-` / `group-` slug prefix (srv/lib/content-store.js catalog
// branch), so a published mission `foo` lives at /tutorials/mission-foo.
//
// Kept pure (no DB, no cds) so it is unit-testable without a round trip.
// The after('READ') decorators in admin-service.js call this per row.

const EMPTY = {
  qaPreviewUrl: undefined, qaPreviewLabel: undefined,
  mainPreviewUrl: undefined, mainPreviewLabel: undefined,
};

const LIVE_LABEL = { mission: 'View Live Mission', group: 'View Live Group' };

export function buildPreviewLinks({ published, slug, kind } = {}) {
  // Sole gate: only published rows with a slug and a known kind get links.
  // Anything else leaves the fields unset so FE renders empty cells.
  if (published !== true || !slug || (kind !== 'mission' && kind !== 'group')) {
    return { ...EMPTY };
  }
  return {
    qaPreviewUrl:     `/tutorials-qa/${kind}-${slug}`,
    qaPreviewLabel:   'View QA Preview',
    mainPreviewUrl:   `/tutorials/${kind}-${slug}`,
    mainPreviewLabel: LIVE_LABEL[kind],
  };
}
