// srv/jobs/refresh-teched-sessions-job.js
//
// Issue #2312: every 6 h, re-pull the SAP TechEd 2026 session catalog (Berlin +
// Virtual) from RainFocus and upsert session/speaker/track METADATA + the
// session↔speaker junction — WITHOUT embedding or LLM concept extraction.
// Purpose: keep the /teched/ page fresh (room/time/title changes, added
// speakers) between the weekly fetch-teched-sessions runs, at zero LLM cost.
//
// Deliberate non-touching (mirrors refresh-community-events-job.js): contentHash
// and lastExtractedHash are OWNED by the weekly fetch-teched-sessions job. This
// job runs runSeed in `metadataOnly` mode, which never reads or writes those
// columns — so a session whose metadata this job refreshes still triggers the
// weekly job's #708 enrichment (its stored contentHash/lastExtractedHash are
// untouched, so the weekly recompute detects the drift). The two jobs are
// idempotent on the same rows.
//
// Fail-open: a fetch/venue error is logged and counted, never thrown.

import cds from '@sap/cds';
import { fetchAllTechEdSessions as defaultFetchAll } from '../lib/teched/rainfocus-fetcher.js';
import { runSeed } from '../lib/teched/seed-core.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const LOG = cds.log('refresh-teched-sessions');

export async function runRefreshTechEdSessions(_logId, opts = {}) {
  const fetchAll = opts.fetchAllTechEdSessions ?? defaultFetchAll;
  const summary = {
    fetched: 0,
    tracksUpserted: 0, speakersUpserted: 0, sessionsUpserted: 0,
    linksReconciled: 0, linksPruned: 0, errors: 0,
  };

  try {
    const db = cds.db ?? await cds.connect.to('db');
    const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = cds.entities(NAMESPACE_EXT);

    let data;
    try {
      data = await fetchAll({ now: Date.now() });
    } catch (err) {
      LOG.error(`fetcher failed: ${err.message}`);
      summary.errors++;
      return summary;
    }
    summary.fetched = (data.sessions ?? []).length;
    if (summary.fetched === 0) {
      LOG.warn('refresh-teched-sessions: fetcher returned no sessions; nothing to do.');
      return summary;
    }

    const seedRes = await runSeed({
      db,
      entities: { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers },
      data,
      commit: true,
      metadataOnly: true,
      now: new Date(),
    });
    summary.tracksUpserted = seedRes.tracks.inserted + seedRes.tracks.updated;
    summary.speakersUpserted = seedRes.speakers.inserted + seedRes.speakers.updated;
    summary.sessionsUpserted = seedRes.sessions.inserted + seedRes.sessions.updated;
    summary.linksReconciled = seedRes.links.inserted;
    summary.linksPruned = seedRes.links.removed;

    LOG.info(JSON.stringify(summary));
    return summary;
  } catch (err) {
    LOG.error(`refresh cycle failed: ${err.message}`);
    summary.errors++;
    return summary;
  }
}
