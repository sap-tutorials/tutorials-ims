using { com.sap.developers.ims as ims } from './schema';
using { managed, cuid } from '@sap/cds/common';

namespace com.sap.developers.ims;

@assert.unique.tokenHashHex: [tokenHashHex]
entity AccountMergeRequests : cuid, managed {
  requesterUser : Association to ims.Users @mandatory; // Account A — bound at request time
  targetEmail   : String(254);                         // Account B email (validated, lowercased)
  targetUser    : Association to ims.Users;            // resolved Account B row (null until found)
  tokenHashHex  : String(64);                          // SHA-256 of magic-link token; plaintext NEVER stored
  status        : String enum { PENDING; VERIFIED; MERGED; EXPIRED; CANCELLED; FAILED } default 'PENDING';
  expiresAt     : Timestamp;
  verifiedAt    : Timestamp;
  mergedAt      : Timestamp;
  requesterIP   : String(45);
}
