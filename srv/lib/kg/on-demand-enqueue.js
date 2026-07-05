// srv/lib/kg/on-demand-enqueue.js
//
// Enqueue an on-demand KG extraction request when expandSearchConcepts
// returns zero seeds. Pure enqueue logic — no LLM calls, no cron
// dependencies, no wait for the drain. Fire-and-forget from the tool.
//
// Coalescing: INSERT ... WHERE NOT EXISTS on normalizedKey ensures at most
// one PENDING/RUNNING row per key. Portable across SQLite (tests) and HANA
// (production). Defense-in-depth on HANA via KG_ONDEMAND_PENDING_UNIQUE
// filtered unique index.
//
// Rate limiting: per-user + global sliding windows via checkRateLimit
// from per-user-rate-limit.js. In-memory, per-process. Multi-instance
// rollout will need a HANA counter table — documented deferred in the
// design spec §2 (env-defaults table).
//
// Fail-open: every early-exit returns a status object; nothing throws.
// The tool handler .catch()es residual DB errors and still returns success
// to the LLM.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
// Issue: #948

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { checkRateLimit } from '../per-user-rate-limit.js';
import { resolveKnowledgeGraphSettings } from '../runtime-config/kg-settings.js';
import * as metrics from '../metrics.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('kg-ondemand-enqueue');
const HOUR_MS = 60 * 60 * 1000;

/**
 * Normalize a raw query to a coalescing key.
 * - Lowercase.
 * - Collapse whitespace runs to a single space.
 * - Strip everything that's neither a word-char (\w) nor whitespace.
 * - Trim.
 * @param {string} rawQuery
 * @returns {string}
 */
export function normalizeQuery(rawQuery) {
  if (typeof rawQuery !== 'string') return '';
  return rawQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Enqueue an on-demand KG extraction request.
 * Never throws. Fire-and-forget from the tool's zero-seed branch.
 *
 * @param {object} opts
 * @param {object} opts.db         cds.connect.to('db') handle
 * @param {string} opts.query      Raw query string (already truncated by the tool's HARD_QUERY_LIMIT)
 * @param {object} opts.requester  { id?, ipHash?, kind: 'user'|'anon' }
 * @returns {Promise<{ status: 'enqueued'|'coalesced'|'rate_limited'|'disabled'|'invalid', normalizedKey?: string, reason?: string }>}
 */
export async function enqueueOnDemandExtraction({ db, query, requester }) {
  // Backward-compat: threading requester is optional at the call site.
  const req = requester ?? { kind: 'anon' };

  try {
    // (1) Flag check.
    const settings = await resolveKnowledgeGraphSettings();
    if (!settings.enabled || !settings.onDemandExtractionEnabled) {
      return { status: 'disabled' };
    }

    // (2) Normalize.
    const normalizedKey = normalizeQuery(query);
    if (!normalizedKey) {
      return { status: 'invalid' };
    }

    // (3) Per-user budget. Anonymous requesters all share the 'anon' bucket key.
    const userLimit = envNumber('KG_ONDEMAND_USER_MAX_PER_HOUR', 3);
    const userBucketKey = `kgondemand:user:${req.kind === 'user' ? (req.id ?? 'unknown') : 'anon'}`;
    if (!checkRateLimit(userBucketKey, userLimit, HOUR_MS)) {
      metrics.emit?.('kg_ondemand_rate_limited', { reason: 'user' });
      return { status: 'rate_limited', reason: 'user' };
    }

    // (4) Global budget.
    const globalLimit = envNumber('KG_ONDEMAND_GLOBAL_MAX_PER_HOUR', 20);
    if (!checkRateLimit('kgondemand:global', globalLimit, HOUR_MS)) {
      metrics.emit?.('kg_ondemand_rate_limited', { reason: 'global' });
      return { status: 'rate_limited', reason: 'global' };
    }

    // (5) INSERT ... WHERE NOT EXISTS (portable coalescing gate).
    //
    // CDS QL cannot express INSERT ... WHERE NOT EXISTS directly, so we use
    // a two-step check-then-insert with the check inside a small tx. The
    // filtered unique index on HANA is the belt-and-braces backstop for the
    // TOCTOU race between the two statements — on the (extremely rare) race,
    // the INSERT fails with a unique-constraint violation which we catch as
    // a coalesce.
    const { KgOnDemandRequests } = cds.entities(NS);
    try {
      return await db.tx(async (tx) => {
        const [existing] = await tx.run(
          SELECT.from(KgOnDemandRequests).columns('ID').where({
            normalizedKey,
            status: { in: ['PENDING', 'RUNNING'] },
          }).limit(1)
        );
        if (existing) {
          metrics.emit?.('kg_ondemand_dedup_coalesced', { normalizedKey });
          return { status: 'coalesced', normalizedKey };
        }
        await tx.run(
          INSERT.into(KgOnDemandRequests).entries({
            ID: randomUUID(),
            query,
            normalizedKey,
            requestedBy: req.kind === 'user' ? (req.id ?? null) : (req.ipHash ?? null),
            requestedByKind: req.kind,
          })
        );
        metrics.emit?.('kg_ondemand_enqueued', {
          normalizedKey,
          requesterKind: req.kind,
        });
        return { status: 'enqueued', normalizedKey };
      });
    } catch (err) {
      // Unique-constraint race -> treat as coalesced. Any other DB error ->
      // swallow, emit metric, return status so the tool never sees a throw.
      const msg = err?.message ?? String(err);
      if (/unique|duplicate|constraint/i.test(msg)) {
        metrics.emit?.('kg_ondemand_dedup_coalesced', { normalizedKey, viaRace: true });
        return { status: 'coalesced', normalizedKey };
      }
      LOG.warn(`enqueueOnDemandExtraction DB error, dropped: ${msg}`);
      metrics.emit?.('kg_ondemand_enqueue_error', { message: msg.slice(0, 200) });
      return { status: 'invalid', reason: 'db_error' };
    }
  } catch (err) {
    // Catches settings lookup, rate limit check, or cds.entities failures.
    // Returns the same shape as DB errors so the tool contract is preserved.
    const msg = err?.message ?? String(err);
    LOG.warn(`enqueueOnDemandExtraction unexpected error: ${msg}`);
    metrics.emit?.('kg_ondemand_enqueue_error', { message: msg.slice(0, 200) });
    return { status: 'invalid', reason: 'db_error' };
  }
}
