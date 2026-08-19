// srv/petoberfest-service.cds
using com.sap.developers.ims as ims from '../db/schema';

@path: '/petoberfest-api'
@requires: 'any'
service PetoberfestService {
  @readonly entity Petoberfests as projection on ims.Petoberfests {
    ID, legacyId, slug, title, intro, status
  };

  function slideshow(slug: String) returns array of {
    id: String; petName: String; uploaderName: String; uploadedAt: Timestamp;
  };

  @(requires: 'authenticated-user')
  function myUploads(slug: String) returns array of {
    id: String; petName: String; moderation: String; uploadedAt: Timestamp;
  };

  // User-initiated takedown of their own submission. Hard-deletes the row (and its
  // inline image blobs); if it was the user's last entry for the contest, their
  // PETOBERFEST completion is superseded (revoked). See design 2026-08-19.
  @(requires: 'authenticated-user')
  action withdraw(slug: String, id: String) returns {
    withdrawn: Boolean; creditRevoked: Boolean;
  };
}
