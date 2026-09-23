// srv/lib/semaphore-sync/config-keys.js
//
// Single source of truth for the `semaphore.sync.*` tuning keys (#2477).
// Both the sync job's readConfig (srv/jobs/semaphore-tag-sync-job.js) and the
// Admin UI panel (AdminService.SemaphoreConfig) import this so the defaults,
// value types, and per-key help live in exactly one place.
//
// These are raw ImsConfig key/value rows (untyped strings on disk). valueType
// records how the job PARSES each string so the UI can validate the same way:
//   'string' — used verbatim (empty → default / undefined).
//   'csv'    — comma-separated list, trimmed, blanks dropped (splitList).
//   'bool'   — 'true'/'false' string; anything but 'false' is truthy for the
//              enable-style keys, but see per-key `parse` for exact semantics.
//
// The Tier-2 intake allowlist (intakeClasses) IS enforced by the applier
// (srv/lib/semaphore-sync/applier.js — a new term is INSERTed only when its SES
// class is allowlisted; empty ⇒ adopt-only, unmatched terms counted
// skippedIntake). The job passes cfg.intakeClasses into applyTerms.

export const SEMAPHORE_CONFIG_KEYS = [
  {
    key: 'semaphore.sync.model',
    label: 'SES model name',
    valueType: 'string',
    default: 'SAPCore',
    description: 'Semaphore SES model to pull terms from.',
  },
  {
    key: 'semaphore.sync.lang',
    label: 'Language',
    valueType: 'string',
    default: 'en',
    description: 'Language code for term labels.',
  },
  {
    key: 'semaphore.sync.filter',
    label: 'SES FILTER clause',
    valueType: 'string',
    default: '',
    description:
      'Optional SES FILTER clause (e.g. "CL=Topic") — shrinks the ~61 MB allterms fetch. Empty = no filter (fetch all).',
  },
  {
    key: 'semaphore.sync.actualTagClasses',
    label: 'Actual-tag classes',
    valueType: 'csv',
    default: '',
    description:
      'Comma-separated class names/URIs whose terms are flagged isActualTag=true by the mapper.',
  },
  {
    key: 'semaphore.sync.interestItemClasses',
    label: 'Interest-item classes',
    valueType: 'csv',
    default: '',
    description:
      'Comma-separated class names/URIs whose terms are flagged isInterestItem=true by the mapper.',
  },
  {
    key: 'semaphore.sync.intakeClasses',
    label: 'Tier-2 intake classes',
    valueType: 'csv',
    default: '',
    description:
      'Tier-2 intake allowlist: comma-separated class names/URIs. A genuinely new term is INSERTed only if its SES class is listed here; empty = adopt-only (unmatched terms are skipped, counted skippedIntake). Enforced by the applier.',
  },
  {
    key: 'semaphore.sync.dryRun',
    label: 'Dry run',
    valueType: 'bool',
    default: 'true',
    description:
      'When true (DEFAULT), a run reports the plan without writing tags — validate the class→flag mapping against real data first. Set to "false" to persist.',
  },
];

// Fast lookups + validation for the setter action's allowlist.
export const SEMAPHORE_CONFIG_KEY_SET = new Set(SEMAPHORE_CONFIG_KEYS.map((k) => k.key));

// Ordered list of just the ImsConfig keys — the job's single-SELECT `in (...)`.
export const SEMAPHORE_CONFIG_KEY_NAMES = SEMAPHORE_CONFIG_KEYS.map((k) => k.key);

/** Default string value for a key (as it would sit in ImsConfig), or '' . */
export function defaultFor(key) {
  const d = SEMAPHORE_CONFIG_KEYS.find((k) => k.key === key);
  return d ? String(d.default ?? '') : '';
}
