namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims, cuid, managed } from './schema';

/**
 * Singleton config (one row, fixed UUID) for the Devtoberfest homepage.
 *
 * Lifecycle:
 *   - The entity has no inline @odata.singleton — that lives on the
 *     AdminService projection in srv/admin-service.cds.
 *   - Defensive insert lives in srv/admin-service.js as a
 *     before('READ', 'DevtoberfestConfig') handler — auto-creates the
 *     row on first access. Same shape as ChatSettings + KnowledgeGraphSettings.
 *   - termsVersion bump forces re-acceptance for unregistered users
 *     mid-flow (via 412 from /api/devtoberfest/join).
 *
 * Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5.1
 */
entity DevtoberfestConfig : cuid {
  currentEvent      : Association to ims.Events;
  termsText         : LargeString;          // markdown body
  termsVersion      : Integer default 1;
  contentRulesUrl   : String(500);
  faqUrl            : String(500);
  gameboardUrl      : String(500);
  activitiesUrl     : String(500);
}

/**
 * One row per (user, event) registration. The @assert.unique.userEvent
 * constraint makes POST /api/devtoberfest/join idempotent — a second
 * call for the same pair fails at the DB layer, which the handler
 * translates to HTTP 409.
 *
 * Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §5.2
 */
@assert.unique.userEvent: [user, event]
entity EventRegistrations : cuid, managed, ims.LegacyKeyed {
  user             : Association to ims.Users @mandatory;
  event            : Association to ims.Events @mandatory;
  joinedAt         : Timestamp;
  termsVersion     : Integer;
  termsAcceptedAt  : Timestamp;
}
