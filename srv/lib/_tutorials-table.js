/**
 * Returns the physical table name and quoted column identifiers for the Tutorials
 * table, branching on the database kind. HANA uses uppercase quoted identifiers;
 * SQLite uses CDS-emitted mixed-case names without quoting.
 *
 * @param {string} namespace - CDS namespace, e.g. "com.sap.developers.ims"
 * @param {boolean} isHana   - true when the active db is SAP HANA
 * @returns {{ table: string, idCol: string, slugCol: string, stepCountCol: string }}
 */
export function tutorialsTableInfo(namespace, isHana) {
  if (isHana) {
    return {
      table: `"${namespace.replace(/\./g, '_').toUpperCase()}_TUTORIALS"`,
      idCol: '"ID"',
      slugCol: '"SLUG"',
      stepCountCol: '"STEPCOUNT"',
    };
  }
  // SQLite: CDS emits the entity name with dots replaced by underscores,
  // preserving the original mixed case (e.g. com_sap_developers_ims_Tutorials).
  return {
    table: `"${namespace.replace(/\./g, '_')}_Tutorials"`,
    idCol: 'ID',
    slugCol: 'slug',
    stepCountCol: 'stepCount',
  };
}
