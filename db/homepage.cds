namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

// Source-of-truth for every shelf entry on the new homepage and verb sub-pages.
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md §10.1

type HomepageVerb : String enum {
  // (#1029) MODEL is the data-platform verb — HANA Cloud, Datasphere,
  // Business Data Cloud, SAC. Slotted between INTEGRATE and OPERATE
  // (sortOrder 35) so the spine reads app → integration → data-as-product
  // → run → AI → community. CAP CDS stays under BUILD (app-modeling).
  LEARN; BUILD; INTEGRATE; MODEL; OPERATE; AI; CONNECT;
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
  // (#763) Persona tag scoring — see design §5.1.
  // Grammar: '<field>:<value>' drawn from PROFILE_VOCAB
  //   role:{developer,architect,sysadmin,student}
  //   deployment:{cloud,onprem}
  //   cloud:{btp,aws,azure,gcp,alibaba,oracle,ibm}
  // Save-time validator in srv/admin-service.js rejects typos.
  personaTags   : array of String(40);
  personaWeight : Integer default 0;
  personaHidden : array of String(40);
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
  // (#763) Kill switch for the personalized-homepage feature.
  // Default false at first migration so a deploy doesn't flip the page
  // for every signed-in user; admin enables via /admin-ui/#homepage.
  personalizationEnabled  : Boolean default false;
}

// (#759) Per-verb explainer content. Cardinality is fixed (6 rows, one
// per HomepageVerb enum value). The admin Fiori app (PR 3) hides
// Create/Delete actions and renders verbKey read-only; the DB schema
// itself is open and admin-mutable. Spec §2.2.
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
// all 7 verb sub-pages — REFERENCE means the same thing on /learn/ and
// /operate/. The admin Fiori app (PR 3) enforces the fixed cardinality;
// the DB schema itself is open. Spec §2.3.
@assert.unique.shelfKey: [shelfKey]
entity ShelfDefinitions : cuid, managed {
  shelfKey        : HomepageShelf @mandatory @assert.range;
  label           : String(40)    @mandatory;
  sortOrder       : Integer       default 100;
  tagline         : String(140);
  whyItMatters    : String(800);
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
}

// (#763) For-you row candidates. Distinct from HomepageShelves because
// being featured in For-you is orthogonal to being in the directory
// footer. Design §5.2.
type ForYouKind : String enum { tutorial; mission; video; blog; shelf; }

entity HomepageForYouCandidates : cuid, managed {
  kind          : ForYouKind    @mandatory @assert.range;
  targetSlug    : String(200)   @mandatory;
  title         : String(255)   @mandatory;
  description   : String(500);
  imageUrl      : String(500);
  personaTags   : array of String(40);
  personaWeight : Integer       default 0;
  personaHidden : array of String(40);
  sortOrder     : Integer       default 100;
  active        : Boolean       default true;
  linkStatus    : HomepageLinkStatus default 'UNKNOWN' @assert.range;
  lastChecked   : Timestamp;
}
