// srv/jobs/kg-community-label-job.js
// Nightly community-labeling job (#1126). Runs ~04:12 UTC, after Louvain
// (03:57) populates KgCommunity. LLM-names each community with >=2 tutorial
// members, keyed on the stable communityFingerprint. Skips communities whose
// full member set is unchanged (memberSlugsHash match) so nightly LLM spend is
// near-zero on stable clusters; a daily budget on ChatSettings ramps a first-run
// backlog over several nights. Fail-open per community; overall throw -> the
// scheduler chassis writes PipelineLog FAILED.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';
import { computeMemberSlugsHash } from '../lib/kg/community-member-hash.js';
import { labelCommunityViaLlm } from '../lib/kg/community-label-llm.js';

const LOG = cds.log('kg-community-label');
const NS = 'com.sap.developers.ims';
const MIN_TUTORIALS = 2;

/**
 * Pure planner — decides which communities need labeling. Unit-testable
 * without a DB. Exported for tests only.
 * @param {object} inp
 * @param {Array<{communityFingerprint:string, tutorialCount:number}>} inp.summaries
 * @param {Record<string,string[]>} inp.membersByFp - fingerprint -> full member slug list
 * @param {Record<string,{memberSlugsHash:string}>} inp.existingLabels
 * @returns {{ toLabel: Array<{communityFingerprint:string, memberSlugsHash:string}>, skipped:number }}
 */
export function _computeForTest({ summaries, membersByFp, existingLabels }) {
  const toLabel = [];
  let skipped = 0;
  for (const s of summaries) {
    if (!s.communityFingerprint || (s.tutorialCount ?? 0) < MIN_TUTORIALS) continue;
    const hash = computeMemberSlugsHash(membersByFp[s.communityFingerprint] || []);
    if (!hash) continue;
    const existing = existingLabels[s.communityFingerprint];
    if (existing && existing.memberSlugsHash === hash) { skipped++; continue; }
    toLabel.push({ communityFingerprint: s.communityFingerprint, memberSlugsHash: hash });
  }
  return { toLabel, skipped };
}

export async function runKgCommunityLabels() {
  const started = Date.now();
  const db = await cds.connect.to('db');
  const { KgCommunity, KgCommunityLabel, KgCommunitySummaryV, ChatSettings, Tutorials, Concepts } = cds.entities(NS);

  // Budget: reset per UTC day.
  const settings = await SELECT.one.from(ChatSettings);
  const budget = settings?.communityLabelLlmBudgetPerDay ?? 50;
  const today = new Date().toISOString().slice(0, 10);
  let callsToday = settings?.communityLabelLlmCallsCountedOn === today ? (settings.communityLabelLlmCallsToday ?? 0) : 0;

  // Load summaries + all memberships once.
  const summaries = await SELECT.from(KgCommunitySummaryV).columns('communityFingerprint', 'tutorialCount');
  const allMembers = await SELECT.from(KgCommunity).columns('communityFingerprint', 'vertexType', 'slug');
  const existingRows = await SELECT.from(KgCommunityLabel).columns('communityFingerprint', 'memberSlugsHash');

  const membersByFp = {};
  const tutorialSlugsByFp = {};
  for (const m of allMembers) {
    if (!m.communityFingerprint || !m.slug) continue;
    (membersByFp[m.communityFingerprint] ||= []).push(m.slug);
    if (m.vertexType === 'tutorial') (tutorialSlugsByFp[m.communityFingerprint] ||= []).push(m.slug);
  }
  const existingLabels = Object.fromEntries(existingRows.map((r) => [r.communityFingerprint, r]));

  const { toLabel, skipped } = _computeForTest({ summaries, membersByFp, existingLabels });

  let labeled = 0, failures = 0, budgetHit = false;
  for (const c of toLabel) {
    if (callsToday >= budget) { budgetHit = true; break; }
    try {
      const tutSlugs = (tutorialSlugsByFp[c.communityFingerprint] || []).map((s) => s.toLowerCase());
      const titleRows = tutSlugs.length
        ? await SELECT.from(Tutorials).columns('title').where({ slug: { in: tutSlugs } })
        : [];
      const conceptSlugs = (membersByFp[c.communityFingerprint] || [])
        .filter((s) => !tutSlugs.includes(s.toLowerCase()));
      const conceptRows = conceptSlugs.length
        ? await SELECT.from(Concepts).columns('name').where({ slug: { in: conceptSlugs } }).limit(10)
        : [];

      const { label, rationale, modelName } = await labelCommunityViaLlm({
        tutorialTitles: titleRows.map((r) => r.title).filter(Boolean),
        conceptNames: conceptRows.map((r) => r.name).filter(Boolean),
      });
      callsToday++;

      // Upsert on communityFingerprint (SELECT-then-UPDATE-or-INSERT).
      const exists = existingLabels[c.communityFingerprint];
      const row = { communityFingerprint: c.communityFingerprint, label, rationale, memberSlugsHash: c.memberSlugsHash, labeledAt: new Date().toISOString(), model: modelName };
      if (exists) await UPDATE(KgCommunityLabel).set(row).where({ communityFingerprint: c.communityFingerprint });
      else await INSERT.into(KgCommunityLabel).entries(row);
      labeled++;
    } catch (err) {
      failures++;
      LOG.warn(`[kg-community-label] fingerprint=${c.communityFingerprint} failed:`, err.message);
    }
  }

  // Persist budget counter.
  if (settings?.ID) {
    await UPDATE(ChatSettings).set({ communityLabelLlmCallsToday: callsToday, communityLabelLlmCallsCountedOn: today }).where({ ID: settings.ID });
  }

  const durationMs = Date.now() - started;
  metrics.observe('kg_community_label_duration_ms', durationMs);
  metrics.gauge('kg_community_label_labeled', labeled);
  metrics.gauge('kg_community_label_skipped', skipped);
  if (failures) metrics.counter('kg_community_label_failures', failures);
  LOG.info(`[kg-community-label] labeled=${labeled} skipped=${skipped} failures=${failures} budgetHit=${budgetHit} in ${durationMs}ms`);

  return { labeled, skipped, budgetHit, failures };
}

export default { runKgCommunityLabels };
