//
// Pure URL/label builder for the ACTIVE-only source & preview links surfaced
// on the admin Tutorials Object Page Lifecycle tab.
// Spec: docs/superpowers/specs/2026-07-28-tutorial-lifecycle-source-preview-links-design.md
//
// Kept pure (no DB, no cds) so the URL logic is unit-testable without a round
// trip. The after('READ','Tutorials') decorator in admin-service.js calls this
// once per row with values it already has (status, slug) plus the RepoCatalog
// lookup (owner, repo, branch).

const GITHUB_BASE = 'https://github.com';
const EMPTY = {
  sourceRepoUrl: undefined, sourceRepoLabel: undefined,
  contribRepoUrl: undefined, contribRepoLabel: undefined,
  qaPreviewUrl: undefined, qaPreviewLabel: undefined,
  mainPreviewUrl: undefined, mainPreviewLabel: undefined,
};

export function buildTutorialLinks({ status, slug, owner, repo, branch } = {}) {
  // Non-ACTIVE rows (and rows with no slug) get no links — FE renders the
  // unset DataFieldWithUrl cells as empty. This is the sole ACTIVE gate.
  if (status !== 'ACTIVE' || !slug) return { ...EMPTY };

  const out = { ...EMPTY };

  // QA + main previews depend only on the slug and are always set for ACTIVE
  // rows, independent of RepoCatalog (so a catalog miss/throw never hides them).
  out.qaPreviewUrl = `/tutorials-qa/${slug}`;
  out.qaPreviewLabel = 'View QA Preview';
  out.mainPreviewUrl = `/tutorials/${slug}`;
  out.mainPreviewLabel = 'View Live Tutorial';

  // GitHub links need a repo. owner/branch fall back to project defaults.
  if (repo) {
    const o = owner || 'sap-tutorials';
    const b = branch || 'main';
    out.sourceRepoUrl = `${GITHUB_BASE}/${o}/${repo}/tree/${b}/tutorials/${slug}`;
    out.sourceRepoLabel = `${o}/${repo}`;
    out.contribRepoUrl = `${GITHUB_BASE}/${o}/${repo}-Contribution/tree/${b}/tutorials/${slug}`;
    out.contribRepoLabel = `${o}/${repo}-Contribution`;
  }

  return out;
}
