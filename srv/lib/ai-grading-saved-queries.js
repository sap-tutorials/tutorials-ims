// srv/lib/ai-grading-saved-queries.js
//
// Canonical SavedQueries seeder for AI-grading token-spend monitoring (#240, Layer 1).
//
// 5 read-only SQL queries pre-populated into AnalyticsSavedQuery on cds.served,
// idempotent (re-running is free). Covers both AI features:
//   - /api/codecheck    (PR #205, #171)
//   - /api/validate-answer  (PR #234, #209)
//
// All queries pass srv/lib/analytics-sql-validator.cjs (allowlisted aggregates +
// CASE WHEN sums, no FILTER/MEDIAN/PERCENTILE/CTE syntax). HANA reserved word
// `timestamp` is double-quoted; date-bucket via CAST AS DATE works on both
// HANA and SQLite.
//
// Visibility: 'shared-admins' so the queries surface for every Admin user, not
// just the seeder's $user identity.
//
// Token-rate constants are NOT embedded in the SQL (rates change; we'd rather
// admins eyeball tokens and multiply in their head or in the runbook than
// hard-code a stale ¢/MTok). Output columns are raw token sums.

import cds from '@sap/cds'

const QUERIES = [
  {
    name: 'AI grading — Daily token spend (validate-answer)',
    description:
      'Daily prompt + completion token totals across /api/validate-answer outcomes. ' +
      'Multiply by your model\'s ¢/1K-token rate in the runbook. ' +
      'Includes "error" verdicts because flake-paths still consume input tokens. ' +
      'Excludes "disabled" — those are short-circuited before any LLM call.',
    sql: `SELECT CAST(createdAt AS DATE) AS day,
                 modelName,
                 COUNT(*) AS submissions,
                 SUM(promptTokens) AS sum_prompt_tokens,
                 SUM(completionTokens) AS sum_completion_tokens,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens
          FROM ValidateAnswerSubmissions
          WHERE errorReason IS NULL OR errorReason <> 'disabled'
          GROUP BY CAST(createdAt AS DATE), modelName
          ORDER BY day DESC, modelName`,
  },
  {
    name: 'AI grading — Daily token spend (code-check)',
    description:
      'Daily prompt + completion token totals across /api/codecheck outcomes. ' +
      'Sibling of the validate-answer rollup so admins can compare the two features ' +
      'side-by-side. Excludes "disabled" — short-circuited before any LLM call.',
    sql: `SELECT CAST(createdAt AS DATE) AS day,
                 modelName,
                 COUNT(*) AS submissions,
                 SUM(promptTokens) AS sum_prompt_tokens,
                 SUM(completionTokens) AS sum_completion_tokens,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens
          FROM CodeCheckSubmissions
          WHERE errorReason IS NULL OR errorReason <> 'disabled'
          GROUP BY CAST(createdAt AS DATE), modelName
          ORDER BY day DESC, modelName`,
  },
  {
    name: 'AI grading — Verdict outcome distribution (validate-answer)',
    description:
      'Counts per (verdict, errorReason), last 7 days. Quick read for "how often is the ' +
      'grader returning pass / partial / fail / error / disabled / wrong_question_type?" ' +
      'Useful for tuning the prompt or flagging operator-mistakes (e.g. spike in ' +
      'wrong_question_type means an author put ai-judged on a multiple-choice).',
    sql: `SELECT verdict,
                 errorReason,
                 COUNT(*) AS row_count,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens
          FROM ValidateAnswerSubmissions
          WHERE createdAt >= ADD_DAYS(CURRENT_DATE, -7)
          GROUP BY verdict, errorReason
          ORDER BY row_count DESC`,
  },
  {
    name: 'AI grading — Top tutorials by token spend, last 7 days (validate-answer)',
    description:
      'Hot-spot detector: which tutorialSlugs are consuming the most tokens? ' +
      'Surfaces tutorials with too-many AI-graded questions or too-long answers. ' +
      'Limit by SQL is 5001 rows (analytics-service.js cap); top 50 should be enough.',
    sql: `SELECT tutorialSlug,
                 COUNT(*) AS submissions,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens,
                 AVG(latencyMs) AS avg_latency_ms
          FROM ValidateAnswerSubmissions
          WHERE createdAt >= ADD_DAYS(CURRENT_DATE, -7)
            AND (errorReason IS NULL OR errorReason <> 'disabled')
          GROUP BY tutorialSlug
          ORDER BY sum_total_tokens DESC`,
  },
  {
    name: 'AI grading — Combined daily spend (both features)',
    description:
      'Aggregate token totals across BOTH /api/codecheck AND /api/validate-answer ' +
      'on the same day. Useful for daily-spend dashboards where the per-feature split ' +
      'is less interesting than total burn. UNION ALL preserves per-feature rows; ' +
      'the runbook can sum them for the headline number.',
    sql: `SELECT 'validate-answer' AS feature,
                 CAST(createdAt AS DATE) AS day,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens,
                 COUNT(*) AS submissions
          FROM ValidateAnswerSubmissions
          WHERE errorReason IS NULL OR errorReason <> 'disabled'
          GROUP BY CAST(createdAt AS DATE)
          UNION ALL
          SELECT 'code-check' AS feature,
                 CAST(createdAt AS DATE) AS day,
                 SUM(promptTokens + completionTokens) AS sum_total_tokens,
                 COUNT(*) AS submissions
          FROM CodeCheckSubmissions
          WHERE errorReason IS NULL OR errorReason <> 'disabled'
          GROUP BY CAST(createdAt AS DATE)
          ORDER BY day DESC, feature`,
  },
]

/**
 * Idempotently seed the AI-grading canonical saved queries.
 * @param {cds.DatabaseService} db
 * @returns {Promise<{inserted: number, total: number}>}
 */
async function seedAiGradingSavedQueries(db) {
  const SavedQuery = 'com.sap.developers.ims.AnalyticsSavedQuery'
  const existing = await db.run(
    SELECT.from(SavedQuery).columns('name').where({ name: { in: QUERIES.map(q => q.name) } })
  )
  const existingNames = new Set(existing.map(r => r.name))
  const toInsert = QUERIES.filter(q => !existingNames.has(q.name))
  if (!toInsert.length) return { inserted: 0, total: QUERIES.length }
  const rows = toInsert.map(q => ({
    name: q.name,
    description: q.description,
    sql: q.sql,
    visibility: 'shared-admins',
    spec: '',                  // Phase-4 builder spec; empty for hand-authored canonical queries
    privacyMode: 'raw',
    createdBy: 'system',
  }))
  await db.run(INSERT.into(SavedQuery).entries(rows))
  return { inserted: toInsert.length, total: QUERIES.length }
}

export { seedAiGradingSavedQueries, QUERIES }
