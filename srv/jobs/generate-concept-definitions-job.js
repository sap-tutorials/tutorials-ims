// srv/jobs/generate-concept-definitions-job.js
//
// #2426: fills the empty Concepts.description fields with short, grounded
// Markdown definitions so /concepts/<slug>/ pages lead with an explanation
// instead of a wall of link tiles. Every definition is written as a DRAFT
// (descriptionStatus='DRAFT') and only renders on-page once an admin approves
// it through the review gate (PR-2). Nothing this job writes is ever
// auto-published.
//
// Grounding-first: a concept's definition is generated ONLY from sources
// already linked to it in the KG (help docs, api docs, and the tutorials that
// teach it). A concept with no grounding is SKIPPED — we never ask the model
// to define a concept blind, which is where hallucinated terminology comes
// from. On top of that, generateConceptDefinition hard-rejects any output that
// contains deprecated terminology (concept-terminology-guard.js).
//
// Shape mirrors fetch-help-docs-job.js: DI'd callModel/generateFn test seams,
// a per-cycle budget, a feature-flag gate, and a summary object.

import cds from '@sap/cds';
import { generateConceptDefinition } from '../lib/concept-definition-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';

const NAMESPACE = 'com.sap.developers.ims';
const NAMESPACE_EXT = 'com.sap.developers.ims.external';
const DEFAULT_BUDGET = 200;   // definitions generated per cycle

const LOG = cds.log('generate-concept-definitions');

/**
 * Collect the authoritative sources already linked to a concept, for grounding.
 * Returns [{ title, url, snippet }] — help docs + api docs + teaching tutorials.
 * LOB-safe: we select only bounded metadata columns (title/url/snippet/name),
 * never a LargeString description column.
 */
async function gatherGrounding(db, conceptId) {
  const { HelpDocs, HelpDocConceptLinks, ApiDocs, ApiDocConceptLinks } =
    cds.entities(NAMESPACE_EXT);
  const { TutorialConceptLinks } = cds.entities(NAMESPACE);

  const [helpLinks, apiLinks, teaches] = await Promise.all([
    db.run(SELECT.from(HelpDocConceptLinks)
      .columns('helpDoc_ID', 'snippet').where({ concept_ID: conceptId })),
    // ApiDocConceptLinks has no snippet column; ApiDocs.description is a LOB
    // we must not select alongside metadata (LOB-locator gotcha), so API-doc
    // grounding is title + url only.
    db.run(SELECT.from(ApiDocConceptLinks)
      .columns('apiDoc_ID').where({ concept_ID: conceptId })),
    db.run(SELECT.from(TutorialConceptLinks)
      .columns('tutorial.title as title').where({ concept_ID: conceptId, predicate: 'teaches' })),
  ]);

  const grounding = [];

  if (helpLinks.length) {
    const docs = await db.run(SELECT.from(HelpDocs)
      .columns('ID', 'title', 'url').where({ ID: { in: helpLinks.map(l => l.helpDoc_ID) } }));
    const byId = Object.fromEntries(docs.map(d => [d.ID, d]));
    for (const l of helpLinks) {
      const d = byId[l.helpDoc_ID];
      if (d) grounding.push({ title: d.title, url: d.url, snippet: l.snippet });
    }
  }
  if (apiLinks.length) {
    const docs = await db.run(SELECT.from(ApiDocs)
      .columns('ID', 'title', 'url').where({ ID: { in: apiLinks.map(l => l.apiDoc_ID) } }));
    const byId = Object.fromEntries(docs.map(d => [d.ID, d]));
    for (const l of apiLinks) {
      const d = byId[l.apiDoc_ID];
      if (d) grounding.push({ title: d.title, url: d.url });
    }
  }
  for (const t of teaches) {
    if (t.title) grounding.push({ title: `Tutorial: ${t.title}` });
  }
  return grounding;
}

/**
 * @param {string|null} logId — passed from runWithLock; ignored here.
 * @param {object} [opts]
 * @param {object}   [opts.db]              — db service (test seam)
 * @param {Function} [opts.callModel]       — LLM call fn (test seam)
 * @param {Function} [opts.generateFn]      — full generate fn (test seam)
 * @param {number}   [opts.budgetOverride]  — bypass the per-cycle budget
 * @param {boolean}  [opts.manualTrigger]   — bypass the feature-flag gate (admin-triggered)
 * @param {boolean}  [opts.redraft]         — also re-draft concepts already in DRAFT (default: only null)
 * @returns {Promise<object>} summary
 */
export async function runGenerateConceptDefinitions(logId, opts = {}) {
  const db = opts.db ?? (await cds.connect.to('db'));
  const callModel = opts.callModel ?? defaultCallModel;
  const generateFn = opts.generateFn
    ?? (async (input) => generateConceptDefinition({ ...input, callModel }));

  const summary = {
    candidates: 0, generated: 0, skippedNoGrounding: 0,
    rejectedTerminology: 0, rejectedOther: 0, errors: 0,
    promptTokens: 0, completionTokens: 0, durationMs: 0,
  };
  const started = Date.now();

  // Feature-flag gate (DEV-first, default OFF). manualTrigger bypasses it.
  const kg = await resolveKnowledgeGraphSettings();
  if (!kg.conceptDefinitionsEnabled && !opts.manualTrigger) {
    LOG.info('conceptDefinitionsEnabled=false and no manualTrigger — skipping');
    summary.durationMs = Date.now() - started;
    return summary;
  }

  const budget = opts.budgetOverride ?? DEFAULT_BUDGET;
  const { Concepts } = cds.entities(NAMESPACE);

  // ACTIVE concepts whose definition is not yet APPROVED. By default only
  // never-drafted concepts (descriptionStatus IS NULL); with redraft, DRAFT
  // ones too. APPROVED is never touched — an admin's decision stands.
  const statusFilter = opts.redraft
    ? { descriptionStatus: { in: [null, 'DRAFT'] } }
    : { descriptionStatus: null };
  const candidates = await db.run(
    SELECT.from(Concepts).columns('ID', 'slug', 'name')
      .where({ status: 'ACTIVE', ...statusFilter })
      .limit(budget)
  );
  summary.candidates = candidates.length;

  for (const concept of candidates) {
    try {
      const grounding = await gatherGrounding(db, concept.ID);
      if (!grounding.length) {
        summary.skippedNoGrounding++;
        continue;
      }
      const result = await generateFn({ concept, grounding });
      summary.promptTokens += result.promptTokens ?? 0;
      summary.completionTokens += result.completionTokens ?? 0;

      if (!result.definition) {
        if (result.reason === 'stale-terminology') summary.rejectedTerminology++;
        else summary.rejectedOther++;
        continue;
      }

      await db.run(
        UPDATE(Concepts)
          .set({ description: result.definition, descriptionStatus: 'DRAFT' })
          .where({ ID: concept.ID })
      );
      summary.generated++;
    } catch (err) {
      summary.errors++;
      LOG.warn(`definition generation failed for ${concept.slug}: ${err.message ?? err}`);
    }
  }

  summary.durationMs = Date.now() - started;
  LOG.info('generate-concept-definitions summary', summary);
  return summary;
}
