using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/mcp-pats';

@path: '/pats'
@requires: 'authenticated-user'
service PatService {

  // User-owned PATs. Everyone sees their own via the row-scoping restrict clause.
  // `user` is exposed (not shown in any UI annotation) so the restrict
  // where-clause `user.email = $user.id` can resolve against the projection —
  // both for READ and for the bound revokePAT existence check (#1132).
  @(restrict: [{ grant: '*', to: 'authenticated-user', where: 'user.email = $user.id' }])
  entity MyPATs as projection on ims.PATs {
    ID, name, prefix, scopes, createdAt, expiresAt, lastUsedAt, revokedAt, createdFromIP, user,
    // #1132: virtual fields for the FE list — populated by after('READ') in
    // pat-service.js. statusText/statusCriticality drive a red/green badge;
    // revocable gates the line-item Revoke button off already-revoked rows.
    virtual null as statusText        : String,
    virtual null as statusCriticality : Integer,
    virtual null as revocable         : Boolean
  } actions {
    // #1132: revokePAT is a BOUND action on MyPATs so Fiori Elements can
    // render it as a line-item DataFieldForAction (clean per-row button with
    // built-in confirmation via @Common.IsActionCritical). The row context
    // supplies the key, so no `ID` parameter is declared — the handler reads
    // it from `req.params` (see handleRevokePAT in lib/mcp-pat-actions.js).
    @Common.IsActionCritical: true
    action revokePAT() returns { ok: Boolean; revokedAt: Timestamp };
  };

  /** Mint a new Personal Access Token. Returns the plaintext ONCE. */
  action mintPAT(name: String(80), scopes: array of String, ttlDays: Integer)
    returns { ID: UUID; token: String; prefix: String; expiresAt: Timestamp };

  // #2857: UI capability probe. The mint dialog calls this to decide whether to
  // offer the `admin` scope — it is shown ONLY when the caller may actually mint
  // an admin PAT, mirroring the backend mint gate (handleMintPAT: flag ON AND a
  // live XSUAA Admin role). Returning false keeps non-admins from selecting a
  // scope that would 403 at mint time (and strands them per #2857).
  /** May the caller mint an admin-scoped PAT right now? */
  function patCapabilities() returns { adminScopeAvailable: Boolean };
}
