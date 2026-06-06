/**
 * Pure helpers for reconcile-tutorials-legacyid.cjs.
 * No HANA / CF / fs side-effects here.
 */
'use strict';

/**
 * Extract a tutorial slug from an IMS task URL.
 *
 *   https://github.com/<org>/<repo>/blob/<branch>/tutorials/<folder>/<slug>.md
 *   -> <slug>
 *
 * Edge cases:
 *   - empty/null URL -> null
 *   - URL without .md ending -> null
 *   - URL with non-canonical slug shape -> null
 *
 * Returns null if no slug can be derived.
 */
function deriveSlug(url) {
  if (!url || typeof url !== 'string') return null;
  // Strip query / fragment if present
  const cleanUrl = url.split('?')[0].split('#')[0];
  const lastSegment = cleanUrl.split('/').pop();
  if (!lastSegment) return null;
  if (!lastSegment.endsWith('.md')) return null;
  const slug = lastSegment.slice(0, -3);
  if (!slug) return null;
  // Sanity: only alphanum and hyphens (canonical slug shape)
  if (!/^[a-z0-9][-a-z0-9]*$/i.test(slug)) return null;
  return slug.toLowerCase();
}

/**
 * Score an IMS task URL for canonical-ness when picking among duplicates.
 * Higher score = more likely to be the "real" canonical task.
 *
 * Heuristics:
 *   +1000 if URL is on the canonical sap-tutorials org
 *   +100  if URL points to master/main branch
 *
 * Note: Loose scoring intentionally. IMS prod is heavy on personal forks
 * (migration testing), and the canonical sap-tutorials org has only ~11
 * task rows. Any non-DELETED match is preferred over no match. Negative
 * penalties for "test repos" were removed because they exclude legitimate
 * matches in dev forks.
 *
 * @param {string} url
 * @returns {number}
 */
function scoreCanonicalUrl(url) {
  if (!url || typeof url !== 'string') return 0;
  let score = 0;
  if (/github\.com\/sap-tutorials\//i.test(url)) score += 1000;
  if (/\/blob\/(master|main)\//i.test(url)) score += 100;
  return score;
}

/**
 * Pick the best IMS task ID from a set of candidates matching a slug.
 *
 * Strategy:
 *   1. Filter out DELETED entries (TASK_STATUS = 'DELETED')
 *   2. Score each candidate's URL canonical-ness
 *   3. Pick the highest score; break ties by lowest ID (oldest = most likely original)
 *
 * @param {Array<{ID: number, URL: string, TASK_STATUS: string|null}>} candidates
 * @returns {{ID: number, URL: string} | null} - chosen task or null if none viable
 */
function pickBestImsTask(candidates) {
  const live = candidates.filter(c => c.TASK_STATUS !== 'DELETED');
  if (live.length === 0) return null;
  let best = live[0];
  let bestScore = scoreCanonicalUrl(best.URL);
  for (const c of live.slice(1)) {
    const score = scoreCanonicalUrl(c.URL);
    if (score > bestScore || (score === bestScore && Number(c.ID) < Number(best.ID))) {
      best = c;
      bestScore = score;
    }
  }
  return { ID: Number(best.ID), URL: best.URL, score: bestScore };
}

/**
 * Compute UPDATE plan for TUTORIALS.LEGACYID reconciliation.
 *
 * @param {Array<{ID: string, SLUG: string, LEGACYID: number|null}>} tutorialRows
 * @param {Map<string, Array<{ID: number, URL: string, TASK_STATUS: string|null}>>} imsTasksBySlug
 * @returns {{updates: Array<{tutorialId, slug, newLegacyId, score, oldLegacyId}>, stats: object}}
 */
function planUpdates(tutorialRows, imsTasksBySlug) {
  const updates = [];
  const stats = {
    matched: 0,
    alreadyCorrect: 0,
    noImsMatch: 0,
    onlyDeletedMatches: 0,
    candidates: 0,
  };
  for (const tut of tutorialRows) {
    const slug = (tut.SLUG || '').toLowerCase();
    const candidates = imsTasksBySlug.get(slug);
    if (!candidates || candidates.length === 0) {
      stats.noImsMatch++;
      continue;
    }
    stats.candidates += candidates.length;
    const best = pickBestImsTask(candidates);
    if (!best) {
      stats.onlyDeletedMatches++;
      continue;
    }
    if (Number(tut.LEGACYID) === best.ID) {
      stats.alreadyCorrect++;
      continue;
    }
    stats.matched++;
    updates.push({
      tutorialId: tut.ID,
      slug,
      newLegacyId: best.ID,
      oldLegacyId: tut.LEGACYID == null ? null : Number(tut.LEGACYID),
      score: best.score,
      url: best.URL,
    });
  }
  return { updates, stats };
}

module.exports = { deriveSlug, scoreCanonicalUrl, pickBestImsTask, planUpdates };
