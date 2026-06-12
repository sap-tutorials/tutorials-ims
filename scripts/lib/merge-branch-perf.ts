// Issue #172 PR 5 — isomorphic merge helper for branch analytics.
// Joins AnalyticsBranchPerformance rows with AnalyticsBranchTopPick rows on
// (missionSlug, tutorialSlug, branchPointId, surface) and computes derived
// columns. NOT a SQL view because the four-tuple-keyed top-pick lookup is
// awkward in HANA SQL but trivial in JS, AND because we want the same code
// to run in the Fiori ObjectPage extension (via AMD shim, see Task 7).
//
// Used by:
//   - Fiori ObjectPage controller extension (Task 6)
//   - lint:tutorial-markdown branchStalenessRule (Task 8)
//   - hybrid test (Task 10)
//
// Spec: §4.3 + §6 edge case "ties + null missionSlug + zero-total guards"

export interface BranchPerfRow {
  missionSlug: string | null;
  tutorialSlug: string;
  branchPointId: string;
  surface: string;
  total: number;
  byCondition: number;
  byRanker: number;
  byDefault: number;
  clickedTotal: number;
  followed: number;
  avgConfidence: number | null;
  bySrcJouleTool: number;
  bySrcPageLoad: number;
  bySrcClick: number;
  firstSeenAt: string | null;
}

export interface BranchTopPickRow {
  missionSlug: string | null;
  tutorialSlug: string;
  branchPointId: string;
  surface: string;
  recommendedKey: string;
  pickedCount: number;
}

export interface MergedBranchPerfRow extends BranchPerfRow {
  pickedKeyTop: string | null;
  pickedKeyTopShare: number | null;
  followRate: number | null;
  clickRate: number | null;
}

const KEY_SEP = '\x1f';  // ASCII unit separator — safe vs slug content
function joinKey(r: { missionSlug: string | null; tutorialSlug: string; branchPointId: string; surface: string }): string {
  return [r.missionSlug ?? '', r.tutorialSlug, r.branchPointId, r.surface].join(KEY_SEP);
}

export function mergeBranchPerf(perf: BranchPerfRow[], top: BranchTopPickRow[]): MergedBranchPerfRow[] {
  // Bucket top-picks by composite key.
  const byKey = new Map<string, BranchTopPickRow[]>();
  for (const t of top) {
    const k = joinKey(t);
    let list = byKey.get(k);
    if (!list) { list = []; byKey.set(k, list); }
    list.push(t);
  }

  return perf.map(p => {
    const picks = byKey.get(joinKey(p)) ?? [];
    let pickedKeyTop: string | null = null;
    let pickedKeyTopShare: number | null = null;
    if (picks.length > 0) {
      // Sort by (pickedCount DESC, recommendedKey ASC) for deterministic tie-break.
      const sorted = picks.slice().sort((a, b) => {
        if (b.pickedCount !== a.pickedCount) return b.pickedCount - a.pickedCount;
        return a.recommendedKey.localeCompare(b.recommendedKey);
      });
      pickedKeyTop = sorted[0].recommendedKey;
      const sumPicks = picks.reduce((s, x) => s + x.pickedCount, 0);
      pickedKeyTopShare = sumPicks > 0 ? sorted[0].pickedCount / sumPicks : null;
    }
    return {
      ...p,
      pickedKeyTop,
      pickedKeyTopShare,
      // followRate uses clickedTotal as denominator (followed only meaningful when click happened).
      followRate: p.clickedTotal > 0 ? p.followed / p.clickedTotal : null,
      // clickRate uses total decisions as denominator. 0/N=0 is deterministic; null only on N=0.
      clickRate:  p.total > 0 ? p.clickedTotal / p.total : null,
    };
  });
}
