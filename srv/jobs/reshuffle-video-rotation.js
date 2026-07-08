// srv/jobs/reshuffle-video-rotation.js
//
// (#1031) Every-4h cron: rewrites HomepageVideoRotation with the top-N
// videos by view velocity (views per day since publishedAt) over the
// trailing videoBandRotationWindowDays window.
//
// Runs inside a single cds.tx so a partial write cannot half-populate the
// sidecar: if any statement throws, the transaction ROLLBACKs and the
// previous rotation stays live.
//
// Fail-quiet: on any thrown error, previous rotation continues to serve
// (visitors keep seeing yesterday's picks). Cron chassis records the
// error via runWithLock's finally block.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NS_EXT = 'com.sap.developers.ims.external';
const NS = 'com.sap.developers.ims';
const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';
const LOG = cds.log('reshuffle-video-rotation');

/**
 * @returns {Promise<{inserted: number, poolSize: number, durationMs: number}>}
 */
export async function runReshuffleVideoRotation() {
  const startedAt = Date.now();
  const db = cds.db ?? await cds.connect.to('db');
  const { HomepageConfig, HomepageVideoRotation } = cds.entities(NS);
  const { Videos } = cds.entities(NS_EXT);

  // 1. Read config knobs; fall back to safe defaults if the config row is missing.
  let rotationCount = 3;
  let windowDays = 90;
  try {
    const cfg = await db.run(
      SELECT.one.from(HomepageConfig)
        .columns('videoBandRotationCount', 'videoBandRotationWindowDays')
        .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID })
    );
    if (cfg) {
      if (Number.isFinite(cfg.videoBandRotationCount))       rotationCount = cfg.videoBandRotationCount;
      if (Number.isFinite(cfg.videoBandRotationWindowDays))  windowDays    = cfg.videoBandRotationWindowDays;
    }
  } catch (err) {
    LOG.warn(`config read failed; using defaults: ${err.message}`);
  }

  // 2. Candidate pool — bounded by window + exclude flag.
  const windowCutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const pool = await db.run(
    SELECT.from(Videos)
      .columns('ID', 'publishedAt', 'viewCount')
      .where({ excludeFromHomepage: false, publishedAt: { '>=': windowCutoff } })
  );
  metrics.gauge('homepage.videos.rotation.pool_size', pool.length);

  // 3. Rank by velocity.
  const now = Date.now();
  const ranked = pool
    .map(r => {
      const publishedMs = new Date(r.publishedAt).getTime();
      const daysSince = Math.max(1, (now - publishedMs) / 86400_000);
      const velocity = (Number(r.viewCount) || 0) / daysSince;
      return { id: r.ID, velocity };
    })
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, rotationCount);

  // 4. Single transaction: DELETE all + INSERT new rows.
  try {
    await cds.tx(async (tx) => {
      await tx.run(DELETE.from(HomepageVideoRotation));
      if (ranked.length > 0) {
        await tx.run(INSERT.into(HomepageVideoRotation).entries(
          ranked.map((r, idx) => ({ video_ID: r.id, rank: idx + 1 }))
        ));
      }
    });
  } catch (err) {
    LOG.error(`reshuffle transaction failed; rotation unchanged: ${err.message}`);
    metrics.counter('homepage.videos.rotation.reshuffle[result=error]');
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  metrics.observe('homepage.videos.rotation.duration_ms', durationMs);
  metrics.counter('homepage.videos.rotation.reshuffle[result=ok]');
  LOG.info(`reshuffle: inserted=${ranked.length} pool=${pool.length} ms=${durationMs}`);
  return { inserted: ranked.length, poolSize: pool.length, durationMs };
}
