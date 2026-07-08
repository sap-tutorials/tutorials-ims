// srv/lib/homepage/personalized-envelope.js
//
// (#763) Compose the personalization envelope from profile + DB rows.
// Design §6, §7.

import crypto from 'node:crypto';
import { rankShelves, rankForYou } from './persona-scoring.js';
import { computeVerbOrder } from './persona-map.js';

const VERBS_UPPER = ['LEARN','BUILD','INTEGRATE','MODEL','OPERATE','AI','CONNECT'];
const VERB_TO_LOWER = { LEARN:'learn', BUILD:'build', INTEGRATE:'integrate',
                        MODEL:'model', OPERATE:'operate', AI:'ai', CONNECT:'connect' };

// Cloud-provider fan-out: knowing you're on aws is useful; we always
// include btp too because SAP-first content dominates the corpus.
function deriveVideoFilterTags(profile) {
  const out = [];
  if (profile?.cloud) out.push(profile.cloud);
  if (!out.includes('btp')) out.push('btp');
  return out;
}

// RSS tags are tag-shaped hints matched against blog post categories.
// Keep the map explicit; unknown values contribute nothing.
const ROLE_RSS = {
  developer: ['btp-development'],
  architect: ['architecture'],
  sysadmin:  ['operations'],
  student:   ['getting-started'],
};
const CLOUD_RSS = {
  btp:  ['btp-development'],
  aws:  ['btp-development'],
  azure:['btp-development'],
  gcp:  ['btp-development'],
};

function deriveRssFilterTags(profile) {
  const tags = new Set();
  for (const t of ROLE_RSS[profile?.role] || []) tags.add(t);
  for (const t of CLOUD_RSS[profile?.cloud] || []) tags.add(t);
  return [...tags];
}

// Count how many active shelves per verb match the profile — used by
// computeVerbOrder for the ±1 slot tilt.
function tagCountsPerVerb(shelves, profile) {
  const counts = {};
  for (const s of shelves) {
    const verbKey = VERB_TO_LOWER[s.verb] || String(s.verb || '').toLowerCase();
    if (!verbKey) continue;
    // Only count entries that actually match (positive signal).
    if ((s.personaTags || []).some((t) => {
      const i = t.indexOf(':');
      return i > 0 && profile?.[t.slice(0, i)] === t.slice(i + 1);
    })) {
      counts[verbKey] = (counts[verbKey] || 0) + 1;
    }
  }
  return counts;
}

function buildShelfOverrides(shelves, profile) {
  const overrides = {};
  for (const verbUpper of VERBS_UPPER) {
    const key = VERB_TO_LOWER[verbUpper];
    const rows = shelves.filter((s) => s.verb === verbUpper);
    if (rows.length === 0) continue;

    const staticOrder = [...rows]
      .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100)
        || String(a.title ?? '').localeCompare(String(b.title ?? '')));

    const rankedIDs = rankShelves(rows, profile).map((r) => r.ID);
    const staticIDs = staticOrder.map((r) => r.ID);
    const hidden = staticIDs.filter((id) => !rankedIDs.includes(id));

    const orderChanged = staticIDs
      .filter((id) => rankedIDs.includes(id))
      .some((id, i) => id !== rankedIDs[i]);

    overrides[key] = {
      reorder: orderChanged ? rankedIDs : [],
      hidden,
    };
  }
  return overrides;
}

export function buildEnvelope({ profile, shelves, forYouCandidates, teaserSlugs, preferredEventRegion }) {
  const p = profile || {};
  const verbOrder = computeVerbOrder(p, tagCountsPerVerb(shelves, p));

  const forYou = rankForYou(forYouCandidates, p, { min: 3, max: 8 })
    .map(({ ID, kind, targetSlug, title, description, imageUrl }) =>
      ({ ID, kind, slug: targetSlug, title, description, imageUrl }));

  const shelfOverrides = buildShelfOverrides(shelves, p);

  return {
    profile: {
      role: p.role ?? null,
      deployment: p.deployment ?? null,
      cloud: p.cloud ?? null,
    },
    verbOrder,
    forYou,
    teaserOrder: [...(teaserSlugs || [])].slice(0, 12),
    shelfOverrides,
    videoFilterTags: deriveVideoFilterTags(p),
    rssFilterTags: deriveRssFilterTags(p),
    eventsRegion: preferredEventRegion ?? null,          // #1030
  };
}

export function hashEnvelope(env) {
  return crypto.createHash('sha1')
    .update(JSON.stringify(env))
    .digest('hex')
    .slice(0, 8);
}
