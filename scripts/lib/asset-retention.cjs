'use strict';

/**
 * Compute the retained bundle set for a build.
 * Immutable content-hashed filenames → unioning is always safe.
 * @param {{currentFiles:string[], retainedManifest:{file:string,firstSeenMs:number}[], nowMs:number, windowMs:number}} args
 * @returns {{toDownload:string[], manifest:{file:string,firstSeenMs:number}[]}}
 */
function mergeRetention({ currentFiles, retainedManifest, nowMs, windowMs }) {
  const current = new Set(currentFiles);
  const priorByFile = new Map((retainedManifest || []).map(e => [e.file, e.firstSeenMs]));

  // Current files keep their original firstSeenMs if we've seen them before.
  const manifest = currentFiles.map(file => ({
    file,
    firstSeenMs: priorByFile.has(file) ? priorByFile.get(file) : nowMs,
  }));

  const toDownload = [];
  for (const { file, firstSeenMs } of retainedManifest || []) {
    if (current.has(file)) continue;                 // already in this build
    if (nowMs - firstSeenMs > windowMs) continue;    // expired → prune
    manifest.push({ file, firstSeenMs });
    toDownload.push(file);
  }
  return { toDownload, manifest };
}

module.exports = { mergeRetention };
