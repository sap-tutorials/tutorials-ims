using { com.sap.developers.ims as ims } from '../db/schema';
using { com.sap.developers.ims.HomepageShelves } from '../db/homepage';

// Public homepage data service — no @requires, all endpoints are anonymous. (#639)
// Spec: docs/superpowers/specs/2026-06-27-639-developer-homepage-design.md

@path: '/api/homepage'
service HomepageService {

  // EventCard maps from ims.Events (startDate/name) to the homepage shape.
  type EventCard   { title: String; startsAt: Timestamp; location: String; format: String; register: String; }
  type VideoItem   { videoId: String; title: String; thumbnail: String; publishedAt: Timestamp; }
  type VideoPayload { featured: VideoItem; recent: array of VideoItem; error: String; }
  type RssItem     { title: String; link: String; publishedAt: Timestamp; description: String; }
  type ShelfItem   { ID: UUID; verb: String; shelf: String; sortOrder: Integer; title: String;
                     url: String; description: String; badge: String; isExternal: Boolean; }

  // (#639) Live data band endpoints — all public, no XSUAA scope required.
  function events()              returns array of EventCard;
  function videos()              returns VideoPayload;
  function communityBlogs()      returns array of RssItem;
  function news()                returns array of RssItem;
  function shelves(verb: String) returns array of ShelfItem;
}
