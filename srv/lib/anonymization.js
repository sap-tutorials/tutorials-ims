const ANON_VALUE = 'ANONYMIZED';

/**
 * Build the set of operations needed to anonymize a user.
 * Returns an operations descriptor — the caller (service handler) executes them.
 */
export function buildAnonymizationOps(user) {
  return {
    userUpdate: {
      ID: user.ID,
      sapId: null,
      firstName: ANON_VALUE,
      lastName: ANON_VALUE,
      email: null,
      displayName: ANON_VALUE
    },
    deleteMetadata: true,
    auditFieldsValue: ANON_VALUE
  };
}
