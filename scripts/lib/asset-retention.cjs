'use strict';

/**
 * Compute the retained bundle set for a build.
 * Immutable content-hashed filenames → unioning is always safe.
 *
 * Retention is anchored to LAST-seen, not first-seen (issue: CSS-404 PROD
 * incident). A long-stable asset (e.g. sap-fundamental.<hash>.css unchanged for
 * weeks) keeps re-appearing as a current file, so its lastSeenMs stays fresh;
 * when it finally changes hash and drops out, it is still retained for `windowMs`
 * after it was LAST emitted. The immediately-prior build's assets (those whose
 * lastSeenMs equals the newest recorded build time) are always carried forward
 * regardless of age, so a single deploy transition can never drop an asset that
 * content published against the prior build still references.
 *
 * @param {{currentFiles:string[], retainedManifest:{file:string,firstSeenMs:number,lastSeenMs?:number}[], nowMs:number, windowMs:number}} args
 * @returns {{toDownload:string[], manifest:{file:string,firstSeenMs:number,lastSeenMs:number}[]}}
 */
function mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs }) {
  const current = new Set(currentFiles);
  const prior = retainedManifest || [];
  const priorByFile = new Map(prior.map((e) => [e.file, e]));

  // `lastSeenMs` may be absent on manifests written before this field existed —
  // fall back to firstSeenMs. The "immediately-prior build" is only inferred from
  // entries that carry a REAL lastSeenMs, so legacy manifests keep window-only
  // (first-seen) pruning and don't get spuriously pinned.
  const hasLast = (e) => typeof e.lastSeenMs === 'number';
  const lastOf = (e) => (hasLast(e) ? e.lastSeenMs : e.firstSeenMs);
  const realLastSeens = prior.filter(hasLast).map((e) => e.lastSeenMs);
  const priorBuildMs = realLastSeens.length ? Math.max(...realLastSeens) : null;

  // Current files keep their original firstSeenMs; lastSeenMs is stamped to now.
  const manifest = currentFiles.map((file) => {
    const p = priorByFile.get(file);
    return { file, firstSeenMs: p ? p.firstSeenMs : nowMs, lastSeenMs: nowMs };
  });

  const toDownload = [];
  for (const e of prior) {
    if (current.has(e.file)) continue;                 // already in this build
    const last = lastOf(e);
    const inPriorBuild = hasLast(e) && priorBuildMs !== null && e.lastSeenMs === priorBuildMs;
    // Keep if it was current in the immediately-prior build (unconditional), or
    // it is still within the window since it was last emitted. Otherwise prune.
    if (!inPriorBuild && nowMs - last > windowMs) continue;
    manifest.push({ file: e.file, firstSeenMs: e.firstSeenMs, lastSeenMs: last });
    toDownload.push(e.file);
  }
  return { toDownload, manifest };
}

module.exports = { mergeRetention };
