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
