// srv/lib/runtime-config/kg-settings.js
// Resolves the 5 Knowledge Graph runtime knobs. Layered precedence:
//   1. KnowledgeGraphSettings row via cds.entities (CAP runtime path)
//   2. KnowledgeGraphSettings raw-SQL UPPERCASE (HANA build-pipeline path,
//      reached via the catch fallback when cds.entities('com.sap.developers.ims')
//      throws because the model isn't loaded)
//   3. process.env.KNOWLEDGE_GRAPH_ENABLED / KG_EXTRACT_BUILD_CAP /
//      KG_MERGE_SIM_THRESHOLD / KG_MERGE_SIM_THRESHOLD_EXTRACT / KG_ONDEMAND_ENABLED
//   4. Hardcoded defaults: enabled=false, cap=200, thresholds 0.92/0.85,
//      onDemandExtractionEnabled=false
//
// Inspired by srv/lib/chat-settings-resolver.js (#318), which provides the
// layered DB→env→default pattern. This resolver ADDS a 5-second in-module
// cache because the 3 KG consumers are hotter than chat-settings: the HTTP
// gate fires per /graph/* request, and the 2 cron consumers fire per tick.
// chat-settings-resolver is called once per LLM call and doesn't cache.
// The cache is a tiny Map+timestamp — no npm dep. Self-contained per Phase
// 2-A spec; base helper extraction deferred to Phase 3 once 3+ resolvers
// exist to inform the abstraction.
//
// Backwards-compatible: with an empty DB row, behavior is identical to the
// current process.env reads in the 3 consumer files. Reverting this PR is safe.

import cds from '@sap/cds';

const LOG = cds.log('kg-settings-resolver');

const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = {
  enabled: false,
  extractBuildCap: 200,
  mergeSimThreshold: 0.92,
  mergeSimThresholdExtract: 0.85,
  onDemandExtractionEnabled: false,   // #948
};

/** Read the singleton row, tolerant of build-pipeline contexts where
 *  cds.entities() throws because the model isn't loaded. Returns null on
 *  any failure — caller falls through to env-var path. */
async function readRow() {
  try {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(KnowledgeGraphSettings)) ?? null;
  } catch (capErr) {
    // CAP path failed (model not loaded, etc.). Try raw SQL — same approach
    // chat-settings-resolver uses for the build-pipeline path.
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract, onDemandExtractionEnabled ' +
        'FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (sqlErr) {
      LOG.warn('KnowledgeGraphSettings read failed; using env-var defaults', sqlErr.message);
      return null;
    }
  }
}

/** HANA returns UPPERCASE column names from raw db.run; CAP returns lowercase. */
function pick(row, lower, upper) {
  if (row == null) return null;
  const v = row[lower];
  if (v !== undefined && v !== null) return v;
  const u = row[upper];
  return u !== undefined && u !== null ? u : null;
}

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined) return null;
  return v === 'true';
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve all 5 knobs at once. Returns a fully-populated object (no nulls).
 * @returns {Promise<{ enabled: boolean, extractBuildCap: number,
 *                     mergeSimThreshold: number, mergeSimThresholdExtract: number,
 *                     onDemandExtractionEnabled: boolean }>}
 */
export async function resolveKnowledgeGraphSettings() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const row = await readRow();

  const settings = {
    // Boolean coercion is critical: SQLite stores boolean as 0/1, and the
    // nullish-coalesce (??) does NOT fall through 0. Without Boolean(),
    // s.enabled would be 0 (falsy but not === false) and downstream
    // `s.enabled === false` checks would fail.
    enabled: Boolean(
      pick(row, 'enabled', 'ENABLED')
      ?? envFlag('KNOWLEDGE_GRAPH_ENABLED')
      ?? DEFAULTS.enabled
    ),
    extractBuildCap:
      pick(row, 'extractBuildCap', 'EXTRACTBUILDCAP')
      ?? envNumber('KG_EXTRACT_BUILD_CAP')
      ?? DEFAULTS.extractBuildCap,
    mergeSimThreshold:
      pick(row, 'mergeSimThreshold', 'MERGESIMTHRESHOLD')
      ?? envNumber('KG_MERGE_SIM_THRESHOLD')
      ?? DEFAULTS.mergeSimThreshold,
    mergeSimThresholdExtract:
      pick(row, 'mergeSimThresholdExtract', 'MERGESIMTHRESHOLDEXTRACT')
      ?? envNumber('KG_MERGE_SIM_THRESHOLD_EXTRACT')
      ?? DEFAULTS.mergeSimThresholdExtract,
    onDemandExtractionEnabled: Boolean(
      pick(row, 'onDemandExtractionEnabled', 'ONDEMANDEXTRACTIONENABLED')
      ?? envFlag('KG_ONDEMAND_ENABLED')
      ?? DEFAULTS.onDemandExtractionEnabled
    ),
  };

  _cached = settings;
  _cachedAt = now;
  return settings;
}

/** Test-only: clear the cache so a unit test can assert TTL behavior or
 *  exercise a fresh read after seeding a row. Not exported through any
 *  public surface. */
export function _resetCacheForTests() {
  _cached = null;
  _cachedAt = 0;
}
