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
import { computeConceptInputDigest as realComputeConceptInputDigest } from './concept-input-digest.js';
import { isDeltaSkipCarryForward } from './content-delta-flags.js';
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

// #1795: most auto-extracted KG concepts have no `description`, so the composed
// concept page shipped `<meta name=description content="">` — Lighthouse scored
// the concept SEO at 46. Synthesize a unique, human meta description from the
// concept name (and its tutorial count when available) so every concept page
// gets a non-empty, distinct description. Body copy is unaffected — the detail
// template only shows a description paragraph when the real one is present, so
// this boilerplate lives in <head> only and never renders on-page.
const META_DESC_MAX = 160; // Google truncates around 155–160 chars.

export function conceptMetaDescription(concept) {
  const real = (concept.description || '').trim();
  if (real) return truncateDescription(stripMarkdown(real));
  const name = concept.name;
  const n = Array.isArray(concept.teaches) ? concept.teaches.length : 0;
  const synthesized = n > 0
    ? `Explore ${name} on SAP Developer Center: ${n} hands-on tutorial${n === 1 ? '' : 's'}, prerequisites, and related concepts.`
    : `Learn about ${name} on SAP Developer Center — hands-on SAP tutorials, prerequisites, and related concepts.`;
  return truncateDescription(synthesized);
}

function truncateDescription(s) {
  if (s.length <= META_DESC_MAX) return s;
  return `${s.slice(0, META_DESC_MAX - 1).trimEnd()}…`;
}

// #2426: concept descriptions are now markdown. The <meta name=description>
// must be plain text — strip the common inline markdown so we don't ship
// `**bold**` / `[label](url)` syntax into <head> (SEO regression, cf. #1795).
// Lightweight and self-contained: this runs at publish time on short strings,
// and does not need a full markdown parse.
function stripMarkdown(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // links → label
    .replace(/`([^`]+)`/g, '$1')                    // inline code
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')   // bold / italic
    .replace(/^#{1,6}\s+/gm, '')                    // ATX headings
    .replace(/^>\s?/gm, '')                          // blockquotes
    .replace(/\s+/g, ' ')                            // collapse whitespace/newlines
    .trim();
}

/**
 * Compute a per-concept body hash for delta detection during publish.
 * @param {string} body The concept body HTML (from renderConceptDetail).
 * @param {object} meta The concept metadata { kind, slug, title, description }.
 * @returns {string} SHA256 hex digest of body + NUL + stringified meta.
 */
export function computeConceptBodyHash(body, meta) {
  return createHash('sha256').update(`${body}\u0000${JSON.stringify(meta)}`, 'utf-8').digest('hex');
}

// Helper to extract a subset of an object by keys.
function pick(obj, keys) {
  const result = {};
  for (const k of keys) {
    if (k in obj) result[k] = obj[k];
  }
  return result;
}

/**
 * Compute a hash of the shell chrome halves. Used as part of the conceptPhaseToken:
 * a shell change (new CSS, island refs) changes the token, forcing a full re-render
 * and preventing stale chrome from being served via carry-forward concept BLOBs.
 * @param {{before:string,after:string}} shell
 * @returns {string} SHA256 hex digest.
 */
function shellHash({ before, after }) {
  return createHash('sha256').update(`${before}\u0000${after}`, 'utf-8').digest('hex');
}

/**
 * Compute the conceptPhaseToken = sha256(conceptInputDigest + NUL + shellHash).
 * Stored on ContentManifest at commit; compared on next run for the phase-level skip.
 * @param {string} conceptInputDigest
 * @param {{before:string,after:string}} shell
 * @returns {string}
 */
function computePhaseToken(conceptInputDigest, shell) {
  return createHash('sha256').update(`${conceptInputDigest}\u0000${shellHash(shell)}`, 'utf-8').digest('hex');
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
 * @param {string|null} [args.priorPhaseToken]  conceptPhaseToken stored on the ACTIVE
 *                                    ContentManifest from the previous publish run.
 *                                    null/undefined = first run after migration → always render.
 * @param {string} [args.computedPhaseToken]  Pre-computed token (injected by tests or handler).
 *                                    When absent, computed from conceptInputDigest + shellHash.
 * @param {boolean} [args.carryForwardActive]  Whether concept BLOBs are carried forward at
 *                                    commit (i.e. !isDeltaSkipCarryForward()). Phase skip is
 *                                    only safe when carry-forward is ON — skipped concepts must
 *                                    exist at the new version via carry-forward.
 * @param {string} [args.namespace]  CDS namespace for conceptInputDigest.
 * @param {object} [args.deps]       { buildConceptsPayload, computeConceptInputDigest } — defaults to real.
 * @returns {Promise<{conceptsSeen,conceptsChanged,conceptsSkipped,conceptsErrored,conceptsRecomposed,phaseSkipped,conceptPhaseToken,durationMs}>}
 */
export async function renderConceptsIntoSession({
  db, sessionId, helpers, priorHashes = {}, shell, deps = {},
  priorPhaseToken, computedPhaseToken: injectedPhaseToken, carryForwardActive,
  namespace = DEFAULT_NAMESPACE,
}) {
  const started = Date.now();
  if (!shell || typeof shell.before !== 'string' || typeof shell.after !== 'string') {
    throw new Error('render-concepts: shell unavailable — __shell__ sidecar not yet published');
  }

  const buildConceptsPayloadFn = deps.buildConceptsPayload || realBuildConceptsPayload;
  const computeConceptInputDigestFn = deps.computeConceptInputDigest || realComputeConceptInputDigest;

  // #2802 Level-1 phase skip: skip the entire phase (no 12-table scan, no render loop) when
  // ALL THREE conditions hold:
  //   (a) the freshly computed token equals the prior ACTIVE token (no concept data or shell changed),
  //   (b) shell is unchanged (already encoded in the token via shellHash — explicit here for clarity),
  //   (c) carry-forward is ACTIVE — skipped concepts are served via prior-version BLOBs carried
  //       forward at commit; if carry-forward is disabled the skip must NOT fire.
  //
  // Fail-open: any error computing the token falls through to the full render path.
  // NULL prior token (first run after migration) = always render (seeds the token for next time).
  //
  // Kill-switch: CONCEPT_PHASE_DELTA env var, default ON.
  // Set to 'false' or '0' to disable the optimization (always render full pass).
  let resolvedPhaseToken;
  const phaseSkipEnabled = process.env.CONCEPT_PHASE_DELTA !== 'false' && process.env.CONCEPT_PHASE_DELTA !== '0';
  if (phaseSkipEnabled && priorPhaseToken && carryForwardActive) {
    try {
      if (injectedPhaseToken !== undefined) {
        resolvedPhaseToken = injectedPhaseToken;
      } else {
        const digest = await computeConceptInputDigestFn(db, namespace);
        resolvedPhaseToken = computePhaseToken(digest, shell);
      }
      if (priorPhaseToken === resolvedPhaseToken) {
        return {
          conceptsSeen: 0, conceptsChanged: 0, conceptsSkipped: 0, conceptsErrored: 0,
          conceptsRecomposed: 0, phaseSkipped: true, conceptPhaseToken: resolvedPhaseToken,
          durationMs: Date.now() - started,
        };
      }
    } catch (err) {
      // Fail-open: token compute error → fall through to full render path.
      console.warn(`[render-concepts] phase-token compute failed (fall-through to full render): ${err.message}`);
      resolvedPhaseToken = undefined;
    }
  }

  // Compute the token for the non-skip path so it can be returned for Task 5 to persist.
  // Only compute if not already resolved above (avoids a second digest call on token mismatch).
  if (resolvedPhaseToken === undefined) {
    try {
      if (injectedPhaseToken !== undefined) {
        resolvedPhaseToken = injectedPhaseToken;
      } else {
        const digest = await computeConceptInputDigestFn(db, namespace);
        resolvedPhaseToken = computePhaseToken(digest, shell);
      }
    } catch (err) {
      // Fail-open: token compute error → leave undefined; caller (Task 5) handles null.
      console.warn(`[render-concepts] phase-token compute failed (token will be null at commit): ${err.message}`);
    }
  }

  const payload = await buildConceptsPayloadFn(db);
  const concepts = payload?.concepts || [];
  const conceptsSeen = concepts.length;

  // Render + delta-filter into a flat file map first, so we can enforce the
  // error threshold before writing anything.
  const changedFiles = {}; // slug → base64(gzip(full doc))
  const bodyHashes = {}; // slug → sha256(body + NUL + meta)
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
        description: conceptMetaDescription(raw),
      };
      const fullDoc = composeShell(shell, body, meta);
      const bodyHash = computeConceptBodyHash(body, meta);
      const contentHash = createHash('sha256').update(fullDoc, 'utf-8').digest('hex');
      if (priorHashes[key] === contentHash) {
        conceptsSkipped++;
        continue;
      }
      changedFiles[key] = gzipSync(Buffer.from(fullDoc, 'utf-8')).toString('base64');
      bodyHashes[key] = bodyHash;
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
    await helpers.appendToSession({ sessionId, files, bodyHashes: pick(bodyHashes, slice) });
  }

  const durationMs = Date.now() - started;
  const conceptsChanged = keys.length;
  metrics.observe('concept_render_ms', durationMs);
  metrics.counter('concepts_rendered_total', conceptsChanged);
  metrics.counter('concepts_skipped_total', conceptsSkipped);
  return {
    conceptsSeen, conceptsChanged, conceptsSkipped, conceptsErrored,
    conceptsRecomposed: 0, phaseSkipped: false, conceptPhaseToken: resolvedPhaseToken ?? null,
    durationMs,
  };
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
  // delta skip. Also selects bodyHash (Task 2/4) for Level-2 per-concept skip.
  async function loadPriorConceptHashes() {
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) return {};
    const { ContentFiles } = cds.entities(namespace);
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'contentHash', 'bodyHash');
    const out = {};
    for (const r of rows) {
      if (typeof r.slug === 'string' && r.slug.startsWith('concept-')) {
        out[r.slug] = r.contentHash;
      }
    }
    return out;
  }

  // Load the conceptPhaseToken from the ACTIVE ContentManifest row.
  // Returns null when no ACTIVE manifest exists (first-run / post-migration).
  async function loadPriorPhaseToken() {
    const { ContentManifest } = cds.entities(namespace);
    const [row] = await SELECT.from(ContentManifest)
      .where({ status: 'ACTIVE' })
      .columns('conceptPhaseToken');
    return row?.conceptPhaseToken ?? null;
  }

  async function renderConceptsHandler(req, res) {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    try {
      const db = await cds.connect.to('db');
      const shell = await shellLoader.get(); // { before, after, version } | null
      const priorHashes = await loadPriorConceptHashes();
      // #2802: load prior conceptPhaseToken and carry-forward flag for Level-1 skip.
      const priorPhaseToken = await loadPriorPhaseToken();
      const carryForwardActive = !isDeltaSkipCarryForward();
      const counts = await renderConceptsIntoSession({
        db, sessionId, helpers, priorHashes, shell,
        priorPhaseToken, carryForwardActive, namespace,
      });
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
