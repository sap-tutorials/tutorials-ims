// srv/lib/publish-topics.js
//
// Task 6 of the tag-tree-topics plan. A session-scoped publish phase that
// renders every live topic tag and appends `topic-<slug>` BLOBs to an open
// publish session. Each BLOB is a FULL HTML document: the topic BODY
// (renderTopicDetail) composed into the __shell__ chrome via composeShell,
// mirroring the same pattern used by publish-concepts.js for concept pages.
//
// Dark launch: no publish-content.ts caller yet (Task 7 wires it).

import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { loadLiveTags, buildTopicDetailPayload } from './topics-query.js';
import { renderTopicDetail } from './topic-detail-render.js';
import { composeShell, createShellLoader } from './chrome-shell.js';
import { createSessionHelpers } from './content-publish-session.js';
import * as metrics from './metrics.js';

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
const BATCH_SIZE = 20;
const MAX_ERROR_RATE = 0.05; // >5% of topics erroring aborts the phase

const META_DESC_MAX = 160; // Google truncates around 155–160 chars.

export function topicMetaDescription(topic) {
  const n = topic.tutorials?.length ?? 0;
  const c = topic.concepts?.length ?? 0;
  return `${topic.label}: ${n} tutorial${n === 1 ? '' : 's'} and ${c} concept${c === 1 ? '' : 's'} on developers.sap.com.`.slice(0, META_DESC_MAX);
}

/**
 * Render every live topic into an open publish session.
 *
 * @param {object} args
 * @param {object} args.db           CDS db service (passed to loadLiveTags / buildTopicDetailPayload).
 * @param {string} args.sessionId    Open publish session id.
 * @param {object} args.helpers      { appendToSession } (from createSessionHelpers).
 * @param {object} args.priorHashes  Map of `topic-<slug>` → prior stored
 *                                    contentHash (full-doc sha256) for delta skip.
 * @param {{before:string,after:string}} args.shell  Parsed __shell__ halves.
 * @param {object} [args.deps]       { loadLiveTags, buildTopicDetailPayload } — defaults to real.
 * @returns {Promise<{topicsSeen,topicsChanged,topicsSkipped,topicsErrored,durationMs}>}
 */
export async function renderTopicsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }) {
  const started = Date.now();
  if (!shell || typeof shell.before !== 'string' || typeof shell.after !== 'string') {
    throw new Error('render-topics: shell unavailable — __shell__ sidecar not yet published');
  }
  const _loadLiveTags = deps.loadLiveTags || loadLiveTags;
  const _buildTopicDetailPayload = deps.buildTopicDetailPayload || buildTopicDetailPayload;
  const live = await _loadLiveTags(db);
  const topicsSeen = live.length;

  // Render + delta-filter into a flat file map first, so we can enforce the
  // error threshold before writing anything.
  const changedFiles = {}; // key → base64(gzip(full doc))
  let topicsSkipped = 0;
  let topicsErrored = 0;

  for (const tag of live) {
    const key = `topic-${tag.slug}`;
    try {
      const topic = await _buildTopicDetailPayload(db, tag.slug);
      if (topic.notFound || topic.error) {
        topicsErrored++;
        metrics.counter('topic_render_error');
        console.error(`[render-topics] topic "${tag.slug}" payload returned error/notFound`);
        continue;
      }
      const { body } = renderTopicDetail(topic);
      const meta = {
        kind: 'topic',
        slug: topic.slug,
        title: topic.label,
        description: topicMetaDescription(topic),
      };
      const fullDoc = composeShell(shell, body, meta);
      const contentHash = createHash('sha256').update(fullDoc, 'utf-8').digest('hex');
      if (priorHashes[key] === contentHash) {
        topicsSkipped++;
        continue;
      }
      changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
    } catch (err) {
      topicsErrored++;
      metrics.counter('topic_render_error');
      console.error(`[render-topics] topic "${tag.slug}" render failed — carrying forward prior BLOB: ${err.message}`);
    }
  }

  // Corrupt-run guard: if a large fraction of topics errored, abort so the
  // caller can roll the session back rather than commit a degraded corpus.
  if (topicsSeen > 0 && topicsErrored / topicsSeen > MAX_ERROR_RATE) {
    throw new Error(`render-topics: error rate too high (${topicsErrored}/${topicsSeen}) — aborting phase`);
  }

  // Append in batches of BATCH_SIZE.
  const keys = Object.keys(changedFiles);
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const slice = keys.slice(i, i + BATCH_SIZE);
    const files = {};
    for (const k of slice) files[k] = changedFiles[k];
    await helpers.appendToSession({ sessionId, files });
  }

  const durationMs = Date.now() - started;
  const topicsChanged = keys.length;
  metrics.observe('topic_render_ms', durationMs);
  metrics.counter('topics_rendered_total', topicsChanged);
  metrics.counter('topics_skipped_total', topicsSkipped);
  return { topicsSeen, topicsChanged, topicsSkipped, topicsErrored, durationMs };
}

/**
 * Express handler factory for POST /content/publish/render-topics. Bound to
 * a namespace; owns getActiveVersion + shellLoader + prior-hash lookup.
 */
export function createRenderTopics({ namespace = DEFAULT_NAMESPACE } = {}) {
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });
  const helpers = createSessionHelpers({ namespace });

  // Prior stored hashes for topic-* slugs at the current ACTIVE version, for
  // delta skip. Same source as hashesHandler.
  async function loadPriorTopicHashes() {
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) return {};
    const { ContentFiles } = cds.entities(namespace);
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'contentHash');
    const out = {};
    for (const r of rows) {
      if (typeof r.slug === 'string' && r.slug.startsWith('topic-')) out[r.slug] = r.contentHash;
    }
    return out;
  }

  async function renderTopicsHandler(req, res) {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    try {
      const db = await cds.connect.to('db');
      const shell = await shellLoader.get(); // { before, after, version } | null
      const priorHashes = await loadPriorTopicHashes();
      const counts = await renderTopicsIntoSession({ db, sessionId, helpers, priorHashes, shell });
      return res.status(200).json(counts);
    } catch (err) {
      console.error('[render-topics] phase failed:', err?.message);
      metrics.counter('topic_render_batch_failure');
      // Leave the session for the caller to abort — do not commit here.
      return res.status(500).json({ error: err?.message || 'render-topics failed' });
    }
  }

  return { renderTopicsHandler };
}

const _default = createRenderTopics();
export const renderTopicsHandler = _default.renderTopicsHandler;
