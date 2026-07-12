import cds from '@sap/cds';
import { handleMintPAT, handleRevokePAT } from './lib/mcp-pat-actions.js';

// #1132: Criticality enum for the FE status column.
//   1 = Error (red), 3 = Success (green) — per @com.sap.vocabularies.UI.v1.CriticalityType.
const CRIT_REVOKED = 1;
const CRIT_ACTIVE = 3;

/** Populate the virtual status/revocable fields on each MyPATs row. */
function decorateStatus(rows) {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (!row || typeof row !== 'object') continue;
    const revoked = !!row.revokedAt;
    row.statusText = revoked ? 'Revoked' : 'Active';
    row.statusCriticality = revoked ? CRIT_REVOKED : CRIT_ACTIVE;
    row.revocable = !revoked;
  }
}

export default class PatService extends cds.ApplicationService {
  async init() {
    this.on('mintPAT', handleMintPAT);
    // #1132: revokePAT is now bound to MyPATs (FE line-item action).
    this.on('revokePAT', 'MyPATs', handleRevokePAT);
    // #1132: decorate each row with the virtual status/revocable fields the
    // FE annotations bind to (mirrors the secrets `hasValue` after-READ hook).
    this.after('READ', 'MyPATs', decorateStatus);
    return super.init();
  }
}
