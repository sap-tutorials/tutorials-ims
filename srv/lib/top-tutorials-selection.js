// Pure ranking core for the Top Tutorials carousel (issue #1782). No DB — the
// caller supplies DB-grouped rows + an active-tutorial slug map so this is
// unit-testable and cross-adapter.

const lower = (x) => (x == null ? x : String(x).toLowerCase());

/**
 * @param {Array<{taskLegacyId:number, completions:number|string, lastCompletion:string|Date}>} groupedRows
 * @param {Map<number,string>} slugByLegacyId  active tutorial legacyId → lowercased slug
 * @param {number} topN
 * @returns {Array<{slug:string, completions:number, lastCompletion:(string|Date)}>}
 */
export function selectTopN(groupedRows, slugByLegacyId, topN) {
  const mapped = [];
  for (const r of groupedRows || []) {
    const slug = slugByLegacyId.get(r.taskLegacyId);
    if (!slug) continue; // orphaned legacyId or inactive/retired tutorial
    mapped.push({
      slug: lower(slug),
      completions: Number(r.completions) || 0,
      lastCompletion: r.lastCompletion,
    });
  }
  mapped.sort((a, b) =>
    (b.completions - a.completions) ||
    (new Date(b.lastCompletion).getTime() - new Date(a.lastCompletion).getTime()) ||
    a.slug.localeCompare(b.slug));
  return mapped.slice(0, topN);
}
