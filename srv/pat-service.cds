using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/mcp-pats';

@path: '/pats'
@requires: 'authenticated-user'
service PatService {

  // User-owned PATs. Everyone sees their own via the row-scoping restrict clause.
  @(restrict: [{ grant: '*', to: 'authenticated-user', where: 'user.email = $user.id' }])
  entity MyPATs as projection on ims.PATs {
    ID, name, prefix, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, createdFromIP
  };

  /** Mint a new Personal Access Token. Returns the plaintext ONCE. */
  action mintPAT(name: String(80), scopes: array of String, ttlDays: Integer)
    returns { ID: UUID; token: String; prefix: String; expiresAt: Timestamp };

  /** Revoke an existing PAT owned by the caller. */
  action revokePAT(ID: UUID) returns { ok: Boolean; revokedAt: Timestamp };
}
