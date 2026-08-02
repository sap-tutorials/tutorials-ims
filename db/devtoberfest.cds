namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims, cuid, managed } from './schema';
using { external.devtoberfest as planner } from './external/devtoberfest';

/**
 * Per-Devtoberfest-event configuration row. Multi-row by design: one
 * row per past/current/future Devtoberfest cycle, with exactly one row
 * marked `isActive` at a time for public-facing queries.
 *
 * Lifecycle:
 *   - Admin creates one row per Devtoberfest cycle via Fiori Elements
 *     LR/OP at /admin-ui/#/devtoberfest (draft-enabled).
 *   - Exactly one row carries isActive=true. Toggling the flag on a
 *     draft activation auto-deactivates the previously-active row in
 *     the same transaction — enforced by a CDS handler in
 *     srv/admin-service.js.
 *   - Public handlers (statusHandler, termsHandler, joule tool, etc.)
 *     query `WHERE isActive=true`. Zero active rows → 503
 *     EVENT_NOT_CONFIGURED.
 *   - termsVersion bump forces re-acceptance for unregistered users
 *     mid-flow (via 412 from /api/devtoberfest/join).
 *
 * Spec: docs/superpowers/specs/2026-06-24-devtoberfest-config-multi-row-draft-design.md
 * (supersedes singleton sections of 2026-06-22-devtoberfest-homepage-design.md §5.1)
 */
entity DevtoberfestConfig : cuid, managed {
  isActive          : Boolean default false;
  currentEvent      : Association to ims.Events;
  edition           : Association to planner.Edition;   // planner GUID stored in edition_ID
  termsText         : LargeString;          // markdown body
  termsVersion      : Integer default 1;
  faqText           : LargeString;          // markdown body for the public FAQ page
  contentRulesUrl   : String(500);
  faqUrl            : String(500);
  gameboardUrl      : String(500);
  activitiesUrl     : String(500);
  hasBanner         : Boolean default false;
  bannerUpdatedAt   : Timestamp;
  banner            : Composition of one DevtoberfestBanner on banner.config = $self;
}

/**
 * Per-config hero banner image (the SAP TechEd key visual for that
 * Devtoberfest edition). 1:1 composition: the association IS the key,
 * so exactly one banner row exists per config. Mirrors AdvocatePhotos
 * (db/advocates.cds). Bytes are a single wide WebP rendition produced by
 * the sharp pipeline in srv/lib/devtoberfest-banner-store.js. Served
 * publicly (anonymous) via GET /api/devtoberfest/banner for the active row.
 */
entity DevtoberfestBanner {
  key config    : Association to DevtoberfestConfig not null;
  image         : LargeBinary @Core.MediaType: mimeType;
  mimeType      : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes     : Integer;
  sha256        : String(64);
  width         : Integer;
  height        : Integer;
  uploadedAt    : Timestamp;
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
