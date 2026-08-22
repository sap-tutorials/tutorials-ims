//
// Single source of truth for the content types the homepage topic-cluster
// band can surface, plus pure helpers for href/recency/ranking. No DB access
// here — the resolver in build-topic-cluster-content.js consumes this.

export const TOTAL_ITEMS_PER_CARD = 8;

// Per-type caps prevent any high-volume source from flooding a card.
export const PER_TYPE_CAPS = {
  tutorial: 3, mission: 2, group: 1,
  'learning-journey': 1, 'discovery-mission': 1, 'api-doc': 1, sample: 1, 'help-doc': 1,
  'blog-post': 2, video: 2, 'community-event': 1,
};

// source:'direct'  → member of KgCommunity with matching vertexType; resolve by slug.
// source:'concept' → reached via concept-hop through linkEntity.contentFk.
export const CONTENT_TYPES = [
  { kind: 'tutorial', tier: 'stable', source: 'direct', vertexType: 'tutorial',
    contentEntity: 'Tutorials', titleField: 'title', statusFilter: 'tutorial' },
  { kind: 'mission', tier: 'stable', source: 'direct', vertexType: 'mission',
    contentEntity: 'Missions', titleField: 'title', statusFilter: 'published' },
  { kind: 'group', tier: 'stable', source: 'direct', vertexType: 'group',
    contentEntity: 'Groups', titleField: 'title', statusFilter: 'published' },

  { kind: 'learning-journey', tier: 'stable', source: 'concept', linkEntity: 'LearningJourneyConceptLinks',
    contentFk: 'journey_ID', contentEntity: 'LearningJourneys', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'discovery-mission', tier: 'stable', source: 'concept', linkEntity: 'DiscoveryMissionConceptLinks',
    contentFk: 'mission_ID', contentEntity: 'DiscoveryMissions', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'api-doc', tier: 'stable', source: 'concept', linkEntity: 'ApiDocConceptLinks',
    contentFk: 'apiDoc_ID', contentEntity: 'ApiDocs', titleField: 'title', urlField: 'url', dateField: null },
  { kind: 'sample', tier: 'stable', source: 'concept', linkEntity: 'SampleConceptLinks',
    contentFk: 'sample_ID', contentEntity: 'Samples', titleField: 'title', urlField: 'url', dateField: 'lastCommitAt' },
  { kind: 'help-doc', tier: 'stable', source: 'concept', linkEntity: 'HelpDocConceptLinks',
    contentFk: 'helpDoc_ID', contentEntity: 'HelpDocs', titleField: 'title', urlField: 'url', dateField: null },

  { kind: 'blog-post', tier: 'volatile', source: 'concept', linkEntity: 'BlogPostConceptLinks',
    contentFk: 'post_ID', contentEntity: 'BlogPosts', titleField: 'title', urlField: 'url', dateField: 'postedAt' },
  { kind: 'video', tier: 'volatile', source: 'concept', linkEntity: 'VideoConceptLinks',
    contentFk: 'video_ID', contentEntity: 'Videos', titleField: 'title', urlField: 'url', dateField: 'publishedAt',
    statusFilter: 'video' },
  { kind: 'community-event', tier: 'volatile', source: 'concept', linkEntity: 'CommunityEventConceptLinks',
    contentFk: 'event_ID', contentEntity: 'CommunityEvents', titleField: 'title', urlField: 'url', dateField: 'startDate' },
];

export function hrefFor(kind, slug, url) {
  if (kind === 'tutorial') return `/tutorials/${slug}`;
  if (kind === 'mission') return `/tutorials/mission-${slug}`;
  if (kind === 'group') return `/tutorials/group-${slug}`;
  return url || null; // external content carries an absolute url
}

export function isNewFrom(dateVal, nowMs, windowDays = 30) {
  if (!dateVal) return false;
  const t = Date.parse(dateVal);
  if (Number.isNaN(t)) return false;
  return (nowMs - t) <= windowDays * 86_400_000 && t <= nowMs;
}

// rank = confidence(0..1, direct=1) + recencyBoost(0..0.5) + pagerankBoost(0..0.5)
export function computeRank(item, rankMaps) {
  const conf = typeof item.confidence === 'number' ? item.confidence : 1;
  let recency = 0;
  if (item.dateMs) {
    const ageDays = (item._nowMs ?? Date.parse('2026-08-22Z')) - item.dateMs;
    const days = ageDays / 86_400_000;
    recency = days <= 30 ? 0.5 : days <= 90 ? 0.25 : days <= 365 ? 0.1 : 0;
  }
  let pr = 0;
  if (rankMaps) {
    const m = item.kind === 'tutorial' ? rankMaps.tutorialRank : rankMaps.conceptRank;
    const v = m?.get(item.slug);
    if (typeof v === 'number') pr = 0.5 * Math.max(0, Math.min(1, v));
  }
  return conf + recency + pr;
}

export function rankAndCap(items, { perType = PER_TYPE_CAPS, total = TOTAL_ITEMS_PER_CARD } = {}) {
  const sorted = [...items].sort((a, b) =>
    (b.rank ?? 0) - (a.rank ?? 0) || String(a.title || '').localeCompare(String(b.title || '')));
  const seen = {};
  const kept = [];
  for (const it of sorted) {
    const cap = perType[it.kind] ?? 1;
    seen[it.kind] = seen[it.kind] || 0;
    if (seen[it.kind] >= cap) continue;
    seen[it.kind]++;
    kept.push(it);
    if (kept.length >= total) break;
  }
  return kept;
}
