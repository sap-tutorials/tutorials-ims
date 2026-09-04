namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

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
  ownerType      : ChannelOwnerType;
  isSapOwned     : Boolean default false;
  category       : String(60);
  subcategory    : String(80);
  platform       : String(40);
  status         : ChannelStatus default 'Active';
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
