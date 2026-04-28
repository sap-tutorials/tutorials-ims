import cds from '@sap/cds';

const FORBIDDEN_PATTERNS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE)\b/i;
const SEMICOLON_PATTERN = /;/;

export function validateRule(rule) {
  if (!rule || typeof rule !== 'string' || rule.trim().length === 0) return false;
  const trimmed = rule.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) return false;
  if (FORBIDDEN_PATTERNS.test(rule)) return false;
  if (SEMICOLON_PATTERN.test(rule)) return false;
  return true;
}

export async function evaluateRules(accomplishments, userId, db) {
  const awarded = [];

  for (const acc of accomplishments) {
    if (!validateRule(acc.rule)) continue;

    try {
      const rows = await db.run(acc.rule, [userId]);
      const score = rows?.[0]?.score ?? rows?.[0]?.SCORE ?? 0;
      if (Number(score) >= 100) {
        awarded.push(acc.ID);
      }
    } catch (err) {
      const logger = cds.log('accomplishment-evaluator');
      logger.warn(`Rule evaluation failed for accomplishment ${acc.ID}:`, err.message);
    }
  }

  return awarded;
}
