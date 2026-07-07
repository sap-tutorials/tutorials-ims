// srv/lib/featured-topics-selection.js
// Pure selection function — no DB access. Deterministic given the same inputs.
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §6.

function isConceptPublished(c) {
  return c && c.conceptStatus === 'ACTIVE' && c.conceptPublishedAt != null;
}

function inValidityWindow(row, now) {
  if (row.validFrom && new Date(row.validFrom) > now) return false;
  if (row.validUntil && new Date(row.validUntil) < now) return false;
  return true;
}

function resolveMissionSlugs(row, tutorialRanksByConcept, tutorialsBySlug, missionsPerSlide) {
  const override = Array.isArray(row.missionSlugs) ? row.missionSlugs.filter(Boolean) : [];
  if (override.length > 0 && override.every(s => tutorialsBySlug.has(String(s).toLowerCase()))) {
    return override.slice(0, missionsPerSlide).map(s => String(s).toLowerCase());
  }
  const ranks = tutorialRanksByConcept.get(row.conceptSlug) || [];
  return ranks
    .filter(r => tutorialsBySlug.has(String(r.tutorialSlug).toLowerCase()))
    .slice(0, missionsPerSlide)
    .map(r => String(r.tutorialSlug).toLowerCase());
}

export function selectFeaturedTopics({
  editorial,
  kgCandidates,
  communityByConcept,
  tutorialRanksByConcept,
  tutorialsBySlug,
  targetCount = 8,
  missionsPerSlide = 4,
  now = new Date(),
}) {
  const slots = [];
  const usedConcepts = new Set();
  const usedCommunities = new Set();

  const sortedEditorial = [...editorial]
    .filter(r => r.isActive)
    .filter(r => isConceptPublished(r))
    .filter(r => inValidityWindow(r, now))
    .sort((a, b) => {
      const so = (a.sortOrder ?? 100) - (b.sortOrder ?? 100);
      if (so !== 0) return so;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

  for (const row of sortedEditorial) {
    if (slots.length >= targetCount) break;
    if (usedConcepts.has(row.conceptSlug)) continue;
    const missionSlugs = resolveMissionSlugs(row, tutorialRanksByConcept, tutorialsBySlug, missionsPerSlide);
    if (missionSlugs.length === 0) continue;
    slots.push({
      source: 'EDITORIAL',
      conceptSlug: row.conceptSlug,
      displayTitle: row.displayTitle || row.conceptName,
      missionSlugs,
    });
    usedConcepts.add(row.conceptSlug);
    const fp = communityByConcept.get(row.conceptSlug);
    if (fp) usedCommunities.add(fp);
  }

  for (const cand of kgCandidates) {
    if (slots.length >= targetCount) break;
    if (!isConceptPublished(cand)) continue;
    if (usedConcepts.has(cand.conceptSlug)) continue;
    const fp = communityByConcept.get(cand.conceptSlug);
    if (fp && usedCommunities.has(fp)) continue;
    const missionSlugs = resolveMissionSlugs(
      { conceptSlug: cand.conceptSlug, missionSlugs: null },
      tutorialRanksByConcept,
      tutorialsBySlug,
      missionsPerSlide,
    );
    if (missionSlugs.length === 0) continue;
    slots.push({
      source: 'KG',
      conceptSlug: cand.conceptSlug,
      displayTitle: cand.conceptName,
      missionSlugs,
    });
    usedConcepts.add(cand.conceptSlug);
    if (fp) usedCommunities.add(fp);
  }

  return slots;
}
