namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims.AuthoringStatus } from './homepage';

type ChannelOwnerType : String enum {
  SAP_Official; SAP_Developer_Advocate; SAP_Executive;
  Community_Member; Community_Organization; User_Group;
  Third_party_Training; Third_party_Media; Third_party_Platform;
}
type ChannelStatus : String enum { Active; Archived; Closed; Discontinued; EOL; }

@assert.unique.sourceId: [sourceId]
entity Channels : cuid, managed {
  sourceId       : String(40)  @mandatory;   // "portal-001" — dedup / re-ingest key
  name           : String(200) @mandatory;
  url            : String(500) @mandatory;
  relatedUrls    : array of String(500);
  aliases        : array of String(120);
  purpose        : String(1000);             // cleaned of [cite:] markers at ingest
  notes          : String(1000);
  ownerName      : String(120);
  ownerType      : ChannelOwnerType @assert.range;
  isSapOwned     : Boolean default false;
  category       : String(60);
  subcategory    : String(80);
  platform       : String(80);
  status         : ChannelStatus default 'Active' @assert.range;
  focusAreas     : array of String(60);
  tags           : array of String(40);
  updateFrequency: String(40);
  githubStars    : Integer;
  subscribers    : Integer;

  // ── curation / lifecycle (admin-editable; absent from ingest so re-seed never wipes) ──
  isPublished        : Boolean default true;
  isFeatured         : Boolean default false;
  editorialNote      : String(800);
  contentHash        : String(64);
  ingestBatch        : String(40);
  linkStatus         : String(20) default 'UNKNOWN';
  linkStatusOverride : String(20);
  lastChecked        : Timestamp;
}

// --- P2: editorial clusters (LLM-drafted, human-reviewed) --------------------
entity ChannelCollections : cuid, managed {
  slug            : String(80)  @mandatory;
  title           : String(140) @mandatory;
  intro           : String(1200);
  sortOrder       : Integer default 100;
  isPublished     : Boolean default false;
  authoringStatus : AuthoringStatus default 'BLANK' @assert.range;
  items           : Composition of many ChannelCollectionItems on items.collection = $self;
}

entity ChannelCollectionItems : cuid {
  collection : Association to ChannelCollections;
  channel    : Association to Channels;
  sortOrder  : Integer default 100;
  blurb      : String(280);
}

// --- P3: per-topic crosswalk (Surface C; LLM-drafted, human-reviewed) --------
@assert.unique.pair: [ channel, topicTag ]
entity ChannelTopicMap : cuid, managed {
  channel         : Association to Channels @mandatory;
  topicTag        : String(140) @mandatory;   // mdFormat tag, e.g. "software-product>sap-hana-cloud"
  relevance       : Integer default 50;       // 0-100; orders the per-topic band, desc
  authoringStatus : AuthoringStatus default 'AI_SEEDED' @assert.range;
}

// --- P4: community submission loop (login-required proposals, admin-moderated) ---
type SubmissionKind   : String enum { ADD; EDIT; REMOVE; }
type SubmissionStatus : String enum { PENDING; APPROVED; REJECTED; }

entity ChannelSubmissions : cuid, managed {
  kind          : SubmissionKind   @mandatory @assert.range;
  targetChannel : Association to Channels;              // null for ADD; required for EDIT/REMOVE (enforced in handler)
  proposed      : LargeString;                          // JSON of proposed curated fields (ADD/EDIT); ignored for REMOVE
  rationale     : String(1000);                         // submitter's free-text reason
  submitterId   : String(120);                          // set server-side from req.user.id
  status        : SubmissionStatus default 'PENDING' @assert.range;
  reviewerId    : String(120);                          // set on approve/reject from req.user.id
  reviewNote    : String(800);                          // moderator note
}
