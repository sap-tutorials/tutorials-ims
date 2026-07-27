// srv/lib/publish-concepts.js
//
// Task 3 of the concepts-scale plan (#1327), Thread B. A session-scoped publish
// phase that renders every published concept and appends `concept-<slug>`
// BLOBs to an open publish session — replacing the legacy "walk Hugo output"
// source (errata #8). Each BLOB is a FULL HTML document: the concept BODY
// (renderConceptDetail) composed into the __shell__ chrome via composeShell,
// the same way group/mission catalog pages are rendered. Byte-compatible with
// what today's Hugo pipeline uploads, so the serve path is unchanged.
//
// Dark launch: no publish-content.ts caller yet (Task 5 wires it).

import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { renderConceptDetail } from './concept-detail-render.js';
import { composeShell, createShellLoader } from './chrome-shell.js';
import { createSessionHelpers } from './content-publish-session.js';
import { buildConceptsPayload as realBuildConceptsPayload } from './published-concepts-query.js';
import * as metrics from './metrics.js';

const DEFAULT_NAMESPACE = 'com.sap.developers.ims';
const BATCH_SIZE = 20;
const MAX_ERROR_RATE = 0.05; // >5% of concepts erroring aborts the phase

// buildConceptsPayload emits concept-to-concept refs (requires/requiredBy/
// relatedTo) with a `name` field, but the detail template reads `.title` on
// relationship cards (they share the external-card shape). Map name→title so
// prerequisite/related concept cards render their label.
function mapConceptForRender(c) {
  const relabel = (arr) => (arr || []).map(r => ({ ...r, title: r.title ?? r.name }));
  return {
    ...c,
    requires: relabel(c.requires),
    requiredBy: relabel(c.requiredBy),
    relatedTo: relabel(c.relatedTo),
  };
}

/**
 * Render every published concept into an open publish session.
 *
 * @param {object} args
 * @param {object} args.db           CDS db service (passed to buildConceptsPayload).
 * @param {string} args.sessionId    Open publish session id.
 * @param {object} args.helpers      { appendToSession } (from createSessionHelpers).
 * @param {object} args.priorHashes  Map of `concept-<slug>` → prior stored
 *                                    contentHash (full-doc sha256) for delta skip.
 * @param {{before:string,after:string}} args.shell  Parsed __shell__ halves.
 * @param {object} [args.deps]       { buildConceptsPayload } — defaults to real.
 * @returns {Promise<{conceptsSeen,conceptsChanged,conceptsSkipped,conceptsErrored,durationMs}>}
 */
export async function renderConceptsIntoSession({ db, sessionId, helpers, priorHashes = {}, shell, deps = {} }) {
  const started = Date.now();
  if (!shell || typeof shell.before !== 'string' || typeof shell.after !== 'string') {
    throw new Error('render-concepts: shell unavailable — __shell__ sidecar not yet published');
  }
  const buildConceptsPayload = deps.buildConceptsPayload || realBuildConceptsPayload;
  const payload = await buildConceptsPayload(db);
  const concepts = payload?.concepts || [];
  const conceptsSeen = concepts.length;

  // Render + delta-filter into a flat file map first, so we can enforce the
  // error threshold before writing anything.
  const changedFiles = {}; // slug → base64(gzip(full doc))
  let conceptsSkipped = 0;
  let conceptsErrored = 0;

  for (const raw of concepts) {
    const key = `concept-${raw.slug}`;
    try {
      const { body } = renderConceptDetail(mapConceptForRender(raw), raw);
      const meta = {
        kind: 'concept',
        slug: raw.slug,
        title: raw.name,
        description: raw.description || '',
      };
      const fullDoc = composeShell(shell, body, meta);
      const contentHash = createHash('sha256').update(fullDoc, 'utf-8').digest('hex');
      if (priorHashes[key] === contentHash) {
        conceptsSkipped++;
        continue;
      }
      changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
    } catch (err) {
      conceptsErrored++;
      metrics.counter('concept_render_error');
      console.error(`[render-concepts] concept "${raw.slug}" render failed — carrying forward prior BLOB: ${err.message}`);
    }
  }

  // Corrupt-run guard: if a large fraction of concepts errored, abort so the
  // caller can roll the session back rather than commit a degraded corpus.
  if (conceptsSeen > 0 && conceptsErrored / conceptsSeen > MAX_ERROR_RATE) {
    throw new Error(`render-concepts: error rate too high (${conceptsErrored}/${conceptsSeen}) — aborting phase`);
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
  const conceptsChanged = keys.length;
  metrics.observe('concept_render_ms', durationMs);
  metrics.counter('concepts_rendered_total', conceptsChanged);
  metrics.counter('concepts_skipped_total', conceptsSkipped);
  return { conceptsSeen, conceptsChanged, conceptsSkipped, conceptsErrored, durationMs };
}

/**
 * Express handler factory for POST /content/publish/render-concepts. Bound to
 * a namespace; owns getActiveVersion + shellLoader + prior-hash lookup.
 */
export function createRenderConcepts({ namespace = DEFAULT_NAMESPACE } = {}) {
  const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;

  async function getActiveVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
    return row?.version ?? null;
  }

  const shellLoader = createShellLoader({ namespace, hanaTableName, getActiveVersion });
  const helpers = createSessionHelpers({ namespace });

  // Prior stored hashes for concept-* slugs at the current ACTIVE version, for
  // delta skip. Same source as hashesHandler.
  async function loadPriorConceptHashes() {
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) return {};
    const { ContentFiles } = cds.entities(namespace);
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'contentHash');
    const out = {};
    for (const r of rows) {
      if (typeof r.slug === 'string' && r.slug.startsWith('concept-')) out[r.slug] = r.contentHash;
    }
    return out;
  }

  async function renderConceptsHandler(req, res) {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    try {
      const db = await cds.connect.to('db');
      const shell = await shellLoader.get(); // { before, after, version } | null
      const priorHashes = await loadPriorConceptHashes();
      const counts = await renderConceptsIntoSession({ db, sessionId, helpers, priorHashes, shell });
      return res.status(200).json(counts);
    } catch (err) {
      console.error('[render-concepts] phase failed:', err?.message);
      metrics.counter('concept_render_batch_failure');
      // Leave the session for the caller to abort — do not commit here.
      return res.status(500).json({ error: err?.message || 'render-concepts failed' });
    }
  }

  return { renderConceptsHandler };
}

const _default = createRenderConcepts();
export const renderConceptsHandler = _default.renderConceptsHandler;
