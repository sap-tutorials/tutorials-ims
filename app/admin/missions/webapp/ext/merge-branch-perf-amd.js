// Issue #172 PR 5 — UI5 AMD shim for the isomorphic ESM merge helper at
// scripts/lib/merge-branch-perf.ts. The ESM module is the source of truth;
// this shim is a hand-maintained mirror so UI5's classic AMD loader can
// consume it. ANY change to the ESM module must be mirrored here.
//
// Why a hand mirror and not a bundler step? Bundler-pipeline coupling bit
// us in PR 3 (#251 / Vite-Hugo collisions). Hand mirror is ~30 lines,
// trivially auditable, and the unit test in scripts/lib/__tests__/
// covers the source. The hybrid test (Task 10) re-runs the same merge
// logic against real data; if shim drifts, hybrid breaks loudly.

sap.ui.define([], function () {
  "use strict";

  var KEY_SEP = "\x1f";
  function joinKey(r) {
    return [r.missionSlug == null ? "" : r.missionSlug, r.tutorialSlug, r.branchPointId, r.surface].join(KEY_SEP);
  }

  function mergeBranchPerf(perf, top) {
    var byKey = new Map();
    for (var i = 0; i < top.length; i++) {
      var t = top[i];
      var k = joinKey(t);
      var list = byKey.get(k);
      if (!list) { list = []; byKey.set(k, list); }
      list.push(t);
    }
    return perf.map(function (p) {
      var picks = byKey.get(joinKey(p)) || [];
      var pickedKeyTop = null;
      var pickedKeyTopShare = null;
      if (picks.length > 0) {
        var sorted = picks.slice().sort(function (a, b) {
          if (b.pickedCount !== a.pickedCount) return b.pickedCount - a.pickedCount;
          return a.recommendedKey.localeCompare(b.recommendedKey);
        });
        pickedKeyTop = sorted[0].recommendedKey;
        var sumPicks = picks.reduce(function (s, x) { return s + x.pickedCount; }, 0);
        pickedKeyTopShare = sumPicks > 0 ? sorted[0].pickedCount / sumPicks : null;
      }
      var followRate = p.clickedTotal > 0 ? p.followed / p.clickedTotal : null;
      var clickRate  = p.total > 0 ? p.clickedTotal / p.total : null;
      return Object.assign({}, p, {
        pickedKeyTop: pickedKeyTop,
        pickedKeyTopShare: pickedKeyTopShare,
        followRate: followRate,
        clickRate: clickRate
      });
    });
  }

  return { mergeBranchPerf: mergeBranchPerf };
});
