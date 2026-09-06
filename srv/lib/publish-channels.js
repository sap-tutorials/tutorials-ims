// srv/lib/publish-channels.js
//
// Render-into-session publisher for per-channel BLOB pages (channels-hub
// Phase 2, Direction 2). Mirrors publish-topics.js exactly: renders every
// published channel's detail page and appends `channel-<slug>` BLOBs to an
// open publish session, with the same ≥5% error-rate abort guard and
// batch-append pattern.

import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildChannelDetailPayload } from './build-channel-detail.js';
import { renderChannelDetail } from './channel-detail-render.js';
import { composeShell, createShellLoader } from './chrome-shell.js';
import { createSessionHelpers } from './content-publish-session.js';
import * as metrics from './metrics.js';

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
const BATCH_SIZE = 20;
const MAX_ERROR_RATE = 0.05; // >5% abort

export function channelMetaDescription(channel) {
  const n = channel.topics?.length ?? 0;
  return `${channel.name}: ${n} topic${n === 1 ? '' : 's'} covered on developers.sap.com.`.slice(0, 160);
}

/**
 * Load all published channel slugs from the database.
 *
 * @param {object} db  CDS db service
 * @returns {Promise<string[]>}
 */
async function loadPublishedChannelSlugs(db) {
  const { Channels } = cds.entities(DEFAULT_NAMESPACE);
  const rows = await db.run(
    SELECT.from(Channels).columns('slug', 'sourceId').where({ isPublished: true }),
  );
  // Prefer slug, fallback to sourceId for pre-slug rows.
  return rows.map((r) => (r.slug || r.sourceId)).filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Render every published channel into an open publish session.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string} args.sessionId
 * @param {object} args.helpers  { appendToSession }
 * @param {object} args.priorHashes  Map key → sha256 of prior full doc
 * @param {{before:string,after:string}} args.shell
 * @param {object} [args.deps]  { loadPublishedChannelSlugs, buildChannelDetailPayload }
 */
export async function renderChannelsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }) {
  const started = Date.now();
  if (!shell || typeof shell.before !== 'string' || typeof shell.after !== 'string') {
    throw new Error('render-channels: shell unavailable — __shell__ sidecar not yet published');
  }

  const _loadSlugs = deps.loadPublishedChannelSlugs || loadPublishedChannelSlugs;
  const _buildPayload = deps.buildChannelDetailPayload || buildChannelDetailPayload;

  const slugs = await _loadSlugs(db);
  const channelsSeen = slugs.length;

  const changedFiles = {};
  let channelsSkipped = 0;
  let channelsErrored = 0;

  for (const slug of slugs) {
    const key = `channel-${slug}`;
    try {
      const channel = await _buildPayload(db, slug);
      if (channel.notFound || channel.error) {
        channelsErrored++;
        metrics.counter('channel_render_error');
        console.error(`[render-channels] channel "${slug}" payload returned error/notFound`);
        continue;
      }
      const { body } = renderChannelDetail(channel);
      const meta = {
        kind: 'channel',
        slug: channel.slug,
        title: channel.name,
        description: channelMetaDescription(channel),
      };
      const fullDoc = composeShell(shell, body, meta);
      const contentHash = createHash('sha256').update(fullDoc, 'utf-8').digest('hex');
      if (priorHashes[key] === contentHash) {
        channelsSkipped++;
        continue;
      }
      changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
    } catch (err) {
      channelsErrored++;
      metrics.counter('channel_render_error');
      console.error(`[render-channels] channel "${slug}" render failed: ${err.message}`);
    }
  }

  if (channelsSeen > 0 && channelsErrored / channelsSeen > MAX_ERROR_RATE) {
    throw new Error(`render-channels: error rate too high (${channelsErrored}/${channelsSeen}) — aborting phase`);
  }

  const keys = Object.keys(changedFiles);
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const slice = keys.slice(i, i + BATCH_SIZE);
    const files = {};
    for (const k of slice) files[k] = changedFiles[k];
    await helpers.appendToSession({ sessionId, files });
  }

  const durationMs = Date.now() - started;
  const channelsChanged = keys.length;
  metrics.observe('channel_render_ms', durationMs);
  metrics.counter('channels_rendered_total', channelsChanged);
  metrics.counter('channels_skipped_total', channelsSkipped);
  return { channelsSeen, channelsChanged, channelsSkipped, channelsErrored, durationMs };
}

/**
 * Express handler factory for POST /content/publish/render-channels.
 */
export function createRenderChannels({ namespace = DEFAULT_NAMESPACE } = {}) {
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });
  const helpers = createSessionHelpers({ namespace });

  async function loadPriorChannelHashes() {
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) return {};
    const { ContentFiles } = cds.entities(namespace);
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'contentHash');
    const out = {};
    for (const r of rows) {
      if (typeof r.slug === 'string' && r.slug.startsWith('channel-')) out[r.slug] = r.contentHash;
    }
    return out;
  }

  async function renderChannelsHandler(req, res) {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    try {
      const db = await cds.connect.to('db');
      const shell = await shellLoader.get();
      const priorHashes = await loadPriorChannelHashes();
      const counts = await renderChannelsIntoSession({ db, sessionId, helpers, priorHashes, shell });
      return res.status(200).json(counts);
    } catch (err) {
      console.error('[render-channels] phase failed:', err?.message);
      metrics.counter('channel_render_batch_failure');
      return res.status(500).json({ error: err?.message || 'render-channels failed' });
    }
  }

  return { renderChannelsHandler };
}

const _default = createRenderChannels();
export const renderChannelsHandler = _default.renderChannelsHandler;
