namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

// Source-of-truth for every shelf entry on the new homepage and verb sub-pages.
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md §10.1

type HomepageVerb : String enum {
  LEARN; BUILD; INTEGRATE; OPERATE; AI; CONNECT;
}

type HomepageShelf : String enum {
  START_HERE; REFERENCE; TOOLS; KEEP_CURRENT;
}

type HomepageBadge : String enum {
  NEW; UPDATED; HIDDEN_GEM; THIRD_PARTY;
}

type HomepageLinkStatus : String enum {
  OK; BROKEN; SLOW; UNKNOWN;
}

// (#759) Authoring lifecycle for explainer content. AI bulk-fill skips
// REVIEWED rows; per-row regenerate works on all statuses (with confirm
// dialog for REVIEWED). Spec §2.1.
type AuthoringStatus : String enum {
  BLANK;      // never seeded
  AI_SEEDED;  // last write was the AI generator
  REVIEWED;   // human has confirmed; bulk-fill skips
}

@assert.unique.verbUrl: [verb, url]
entity HomepageShelves : cuid, managed {
  verb        : HomepageVerb       @mandatory @assert.range;
  shelf       : HomepageShelf      @mandatory @assert.range;
  sortOrder   : Integer            default 100;
  title       : String(120)        @mandatory;
  url         : String(500)        @mandatory;
  description : String(280);
  badge       : HomepageBadge      @assert.range;
  isExternal  : Boolean            default true;
  isActive    : Boolean            default true;
  lastChecked : Timestamp;
  linkStatus  : HomepageLinkStatus default 'UNKNOWN' @assert.range;
  // (#759) Explainer content — see spec §2.4. tagline + whyItMatters
  // fill the popover; description stays as a third paragraph for
  // graceful fallback during phased rollout.
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}

// Hand-curated map of legacy URLs → new URLs. Approuter fetches via
// /api/redirects/active and refreshes hourly. Spec §10.2.
@assert.unique.fromPath: [fromPath]
entity LegacyRedirects : cuid, managed {
  fromPath   : String(500) @mandatory;
  toPath     : String(500) @mandatory;
  statusCode : Integer     default 301;
  isPattern  : Boolean     default false;
  isActive   : Boolean     default true;
  hitCount   : Integer     default 0;
}

// Runtime homepage feature config (singleton). Auto-init handler in
// srv/admin-service.js inserts a default row on first read (matches the
// existing pattern for ChatSettings et al.).
// Spec §17 resolution 3.
entity HomepageConfig : cuid, managed {
  developerNewsPlaylistId : String(64);  // YouTube playlist ID for the featured Friday show
  videoBandEnabled        : Boolean default true;
  eventsBandEnabled       : Boolean default true;
  communityLaneEnabled    : Boolean default true;
}

// (#759) Per-verb explainer content. Cardinality is fixed (6 rows, one
// per HomepageVerb enum value). CRUD lockdown in admin UI prevents
// row creation/deletion; only content fields are mutable. Spec §2.2.
@assert.unique.verbKey: [verbKey]
entity VerbDefinitions : cuid, managed {
  verbKey         : HomepageVerb @mandatory @assert.range;
  label           : String(40)   @mandatory;
  iconName        : String(40);
  sortOrder       : Integer      default 100;
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}

// (#759) Per-shelf-category explainer content. Cardinality is fixed
// (4 rows, one per HomepageShelf enum value). Content is shared across
// all 6 verb sub-pages — REFERENCE means the same thing on /learn/ and
// /operate/. Spec §2.3.
@assert.unique.shelfKey: [shelfKey]
entity ShelfDefinitions : cuid, managed {
  shelfKey        : HomepageShelf @mandatory @assert.range;
  label           : String(40)    @mandatory;
  sortOrder       : Integer       default 100;
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}
