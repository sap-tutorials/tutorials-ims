// srv/lib/kg-community-coverage.js
//
// Pure coverage/orphan math for the KG community curator-assist nudges (#1172).
// No DB, no CAP — the caller (after('READ','KgCommunities') in
// srv/admin-service.js) does the batched reads and passes plain data in.
//
// Coverage is computed over TUTORIAL members only (only tutorials can be in a
// mission) and against PUBLISHED missions only. See
// docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md.
const DEFAULT_THRESHOLD = 70;

/**
 * Resolve the coverage-high threshold from env, clamped to 0–100.
 * @param {Record<string,string|undefined>} env
 * @returns {number}
 */
function resolveThreshold(env) {
  const raw = env && env.KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD;
  if (raw == null) return DEFAULT_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 100) return DEFAULT_THRESHOLD;
  return n;
}

/**
 * @param {object} args
 * @param {Map<number,string[]>} args.memberSlugsByCommunity  community ID → tutorial member slugs (lowercase)
 * @param {Array<{slug:string,missionTitle:string,missionSlug:string}>} args.coveredRows
 *        one row per (tutorial slug in a published mission, that mission)
 * @param {number} args.threshold
 * @returns {Map<number, {missionCoveragePct:number|null, dominantMissionTitle:string|null,
 *          dominantMissionSlug:string|null, orphanTutorialCount:number|null, coverageHigh:boolean}>}
 */
function computeCoverage({ memberSlugsByCommunity, coveredRows, threshold }) {
  // slug → [{missionTitle, missionSlug}] restricted later per community.
  const missionsBySlug = new Map();
  for (const row of coveredRows || []) {
    if (!row || !row.slug) continue;
    const s = row.slug.toLowerCase();
    if (!missionsBySlug.has(s)) missionsBySlug.set(s, []);
    missionsBySlug.get(s).push({ missionTitle: row.missionTitle, missionSlug: row.missionSlug });
  }

  const out = new Map();
  for (const [communityId, rawSlugs] of memberSlugsByCommunity) {
    const memberSlugs = [...new Set((rawSlugs || []).filter(Boolean).map((s) => s.toLowerCase()))];
    const total = memberSlugs.length;

    if (total === 0) {
      out.set(communityId, {
        missionCoveragePct: null,
        dominantMissionTitle: null,
        dominantMissionSlug: null,
        orphanTutorialCount: null,
        coverageHigh: false,
      });
      continue;
    }

    // Count coverage per member; tally per-mission how many of THIS community's
    // members it covers (for the dominant-mission pick).
    let covered = 0;
    // missionSlug → { title, count }
    const missionTally = new Map();
    for (const slug of memberSlugs) {
      const missions = missionsBySlug.get(slug);
      if (!missions || missions.length === 0) continue;
      covered += 1;
      // A member counts once toward coverage but toward each covering mission's
      // tally (so a mission that covers more of the cluster wins dominance).
      const seenThisSlug = new Set();
      for (const m of missions) {
        if (seenThisSlug.has(m.missionSlug)) continue;
        seenThisSlug.add(m.missionSlug);
        const cur = missionTally.get(m.missionSlug) || { title: m.missionTitle, count: 0 };
        cur.count += 1;
        missionTally.set(m.missionSlug, cur);
      }
    }

    const pct = Math.round((covered / total) * 100);

    // Dominant mission: highest count, tie broken by title ascending (stable,
    // deterministic across reads).
    let dominantTitle = null;
    let dominantSlug = null;
    if (missionTally.size > 0) {
      const ranked = [...missionTally.entries()].sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        return String(a[1].title).localeCompare(String(b[1].title));
      });
      dominantSlug = ranked[0][0];
      dominantTitle = ranked[0][1].title;
    }

    out.set(communityId, {
      missionCoveragePct: pct,
      dominantMissionTitle: dominantTitle,
      dominantMissionSlug: dominantSlug,
      orphanTutorialCount: total - covered,
      coverageHigh: pct >= threshold,
    });
  }
  return out;
}

export { computeCoverage, resolveThreshold, DEFAULT_THRESHOLD };
