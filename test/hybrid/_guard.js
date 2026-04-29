/**
 * Production safeguard for hybrid write tests.
 * Prevents INSERT/UPDATE/DELETE tests from running against production databases.
 */
export function isSafeForWrites() {
  if (process.env.NODE_ENV === 'production') return false;

  const vcap = process.env.VCAP_SERVICES || '';
  const lower = vcap.toLowerCase();

  // Block if service instance name or credentials suggest production
  if (lower.includes('"imsprod"') || lower.includes('-prod-') || lower.includes('"prod"')) {
    return false;
  }

  // Block if CF_TARGET_SPACE is explicitly a prod space
  const space = process.env.CF_TARGET_SPACE || '';
  if (/prod/i.test(space)) return false;

  return true;
}
