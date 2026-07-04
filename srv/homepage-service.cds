using { com.sap.developers.ims as ims } from '../db/schema';
using { com.sap.developers.ims.HomepageShelves } from '../db/homepage';

// Public homepage data service — all endpoints are anonymous. (#639)
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md
//
// Auth note: @requires: 'any' is CAP's idiom for "anonymous-readable
// service". Without an explicit @requires, the cds-served app's xsuaa
// middleware gates every request and returns 401 — that's how CAP
// fails-secure by default. Sibling public services (DeveloperService,
// EventStreamService, SearchService) all use the same 'any' marker.
//
// Path note: declared at /homepage (NOT /api/homepage) to avoid Express
// prefix-match collision with DeveloperService (@path '/api'). CAP mounts
// services in alphabetical filename order, so developer-service.cds is
// mounted at /api BEFORE homepage-service.cds gets its turn — and Express
// `app.use('/api', …)` is a prefix match that swallows /api/homepage/*
// before this service ever sees the request. Moving HomepageService out of
// the /api namespace removes the overlap entirely. The approuter route
// `^/homepage/(.*)$` (authenticationType: 'none') is the public ingress.

@path: '/homepage'
@requires: 'any'
service HomepageService {

  // EventCard maps from ims.Events (startDate/name) to the homepage shape.
  type EventCard   { title: String; startsAt: Timestamp; location: String; format: String; register: String; }
  type VideoItem   { videoId: String; title: String; thumbnail: String; publishedAt: Timestamp; }
  type VideoPayload { featured: VideoItem; recent: array of VideoItem; error: String; }
  type RssItem     { title: String; link: String; publishedAt: Timestamp; description: String; }
  type ShelfItem   { ID: UUID; verb: String; shelf: String; sortOrder: Integer; title: String;
                     url: String; description: String; badge: String; isExternal: Boolean; }

  // (#639) Redirect types — approuter polling + hit batching.
  type RedirectRow { ID: UUID; fromPath: String; toPath: String; statusCode: Integer; isPattern: Boolean; }
  type HitEntry    { id: UUID; count: Integer; }

  // (#639) Live data band endpoints — all public, no XSUAA scope required.
  function events()              returns array of EventCard;
  function videos()              returns VideoPayload;
  function communityBlogs()      returns array of RssItem;
  function news()                returns array of RssItem;
  function shelves(verb: String) returns array of ShelfItem;

  // (#639) Approuter fetches this hourly to refresh its in-memory redirect map.
  function redirectsActive()                          returns array of RedirectRow;

  // (#639) Approuter batches hit counters and flushes every 60s.
  action   recordRedirectHits(hits: array of HitEntry) returns Integer;

  // (#763) Authenticated personalization envelope. Per-function override of
  // the service-level @requires:'any' — CAP honors the stricter annotation.
  // Returns 204 when the kill switch is off, 200+envelope when on.
  // Response headers: Cache-Control:private,no-store; X-Personalization:1; ETag.
  type PersonalizedProfile { role: String; deployment: String; cloud: String; }
  type ShelfOverride       { reorder: array of UUID; hidden: array of UUID; }
  type ShelfOverrideMap {
    learn: ShelfOverride; build: ShelfOverride; integrate: ShelfOverride;
    operate: ShelfOverride; ai: ShelfOverride; connect: ShelfOverride;
  }
  type ForYouItem {
    ID: UUID; kind: String; slug: String; title: String;
    description: String; imageUrl: String;
  }
  type PersonalizedEnvelope {
    hash            : String;
    profile         : PersonalizedProfile;
    verbOrder       : array of String;
    forYou          : array of ForYouItem;
    teaserOrder     : array of String;
    shelfOverrides  : ShelfOverrideMap;
    videoFilterTags : array of String;
    rssFilterTags   : array of String;
  }

  @(requires: 'authenticated-user')
  function personalized() returns PersonalizedEnvelope;
}
