namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims, cuid, managed } from './schema';

entity Advocates : cuid, managed {
  slug          : String(64) @mandatory;
  firstName     : String(100) @mandatory;
  lastName      : String(100) @mandatory;
  title         : String(255);
  pronouns      : String(32);
  location      : String(120);
  region        : String(16) @assert.range enum { AMERICAS; EMEA; APJ };
  bio           : LargeString;
  isActive      : Boolean default true;
  sortOverride  : Integer;
  joinedDate    : Date;
  hasPhoto      : Boolean default false;
  photoUpdatedAt: Timestamp;
  // Public REST URL for the advocate's avatar (e.g. /api/advocates/thomas-jung/photo).
  // Computed + maintained by the after-handlers in srv/handlers/advocate-handlers.js
  // whenever hasPhoto flips or slug changes. Persisted (not virtual) because PR #404
  // tried the virtual + after-READ approach and hit OData v4 'invalid segment:
  // photoIconUrl' errors on $expand=DraftAdministrativeData reads (draft-enabled
  // entities don't tolerate non-primitive virtuals on $expand paths). The
  // persisted form survives drill-down at the cost of one DB column + a sync
  // invariant the handlers maintain. Issue #415.
  photoUrl      : String(200);
  topics        : Composition of many AdvocateTopics on topics.advocate = $self;
  links         : Composition of many AdvocateLinks  on links.advocate  = $self;
  // Inverse association — required so the admin Object Page can target
  // `photo/@UI.FieldGroup#Photo` for the UploadSet binding (see Phase 6 Task 6.2).
  photo         : Composition of one AdvocatePhotos on photo.advocate = $self;
}

entity AdvocateTopics : cuid {
  advocate : Association to Advocates;
  tag      : Association to ims.Tags;
}

entity AdvocateLinks : cuid {
  advocate  : Association to Advocates;
  kind      : String(32) @assert.range enum {
    LinkedIn; X; Mastodon; BlueSky; GitHub; YouTube; Blog; SapCommunity; Email; Other;
  };
  url       : String(500) @mandatory;
  label     : String(80);
  sortOrder : Integer default 100;
}

entity AdvocatePhotos {
  // One-to-one composition: the association IS the key.
  // CAP generates the FK column `advocate_ID` and uses it as the PK,
  // enforcing 1:1 at the schema level (one photo row per advocate).
  key advocate    : Association to Advocates not null;
  photo256        : LargeBinary @Core.MediaType: photoMimeType;
  photo64         : LargeBinary @Core.MediaType: 'image/webp';
  photoMimeType   : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes       : Integer;
  sha256          : String(64);
  uploadedAt      : Timestamp;
}
