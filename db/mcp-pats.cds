using { com.sap.developers.ims as ims } from './schema';
using { managed, cuid } from '@sap/cds/common';

namespace com.sap.developers.ims;

@assert.unique.hashHex: [hashHex]
entity PATs : cuid, managed {
  user          : Association to ims.Users;
  name          : String(80)  @mandatory;
  prefix        : String(12);           // "pat_" + 8 random alnum; set by mint handler.
  hashHex       : String(64);           // SHA-256 hex of full plaintext.
  scopes        : array of String;      // 'read' | 'write' | both (coarse).
  expiresAt     : Timestamp;            // null = no expiry (UI defaults to 90 days).
  lastUsedAt    : Timestamp;            // best-effort; may lag ~60s.
  revokedAt     : Timestamp;            // null = active.
  createdFromIP : String(45);           // IPv6-safe.
}

/** Server-trusted "this user currently has headless admin authority" grant.
 *  Created/affirmed only when the caller holds the real XSUAA Admin role at
 *  PAT mint time (see srv/lib/mcp-pat-actions.js). Presence of a non-expired
 *  row makes an `admin`-scoped PAT resolve roles ['Admin','Tutorial.API'].
 *  Revoke the row (admin action) to kill all that user's admin PATs live. */
entity AdminGrants : cuid, managed {
  user      : Association to ims.Users  @assert.unique;
  grantedAt : Timestamp;
  grantedBy : String(255);   // email of the admin who minted/affirmed
  expiresAt : Timestamp;
}
