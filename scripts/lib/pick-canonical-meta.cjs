/**
 * Pick the canonical TutorialMeta row when a tutorial has multiple rows.
 *
 * Priority (highest first):
 *   1. Non-null OWNER beats null OWNER.
 *   2. Higher NOTIFICATIONNUMBER wins.
 *   3. More recent REVIEWEDDATE wins (null treated as older than any date).
 *   4. More recent MODIFIEDAT wins (final non-empty tiebreaker).
 *   5. Lower LEGACYID wins (deterministic tiebreaker for fully-equal rows).
 *
 * @param {Array<object>} rows - TutorialMeta rows (uppercase HANA keys).
 * @returns {{ winner: object, losers: Array<object> }}
 */
function pickCanonicalMeta(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('pickCanonicalMeta: rows must be non-empty array');
  }
  if (rows.length === 1) return { winner: rows[0], losers: [] };

  // Score is a tuple compared lexicographically: each field returns a number,
  // higher = "wins". Null values are treated as the lowest possible score.
  const score = (r) => [
    r.OWNER != null ? 1 : 0,
    Number(r.NOTIFICATIONNUMBER ?? 0),
    r.REVIEWEDDATE ? Date.parse(r.REVIEWEDDATE) : -Infinity,
    r.MODIFIEDAT ? Date.parse(r.MODIFIEDAT) : -Infinity,
    // LEGACYID inverted (lower wins) so we negate it so "higher score" still picks lower legacyId
    -(Number(r.LEGACYID ?? Number.MAX_SAFE_INTEGER)),
  ];

  let winner = rows[0];
  let winnerScore = score(winner);
  for (let i = 1; i < rows.length; i++) {
    const s = score(rows[i]);
    for (let j = 0; j < s.length; j++) {
      if (s[j] > winnerScore[j]) { winner = rows[i]; winnerScore = s; break; }
      if (s[j] < winnerScore[j]) break;
    }
  }
  const losers = rows.filter(r => r.ID !== winner.ID);
  return { winner, losers };
}

module.exports = { pickCanonicalMeta };
