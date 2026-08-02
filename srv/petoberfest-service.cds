// srv/petoberfest-service.cds
using com.sap.developers.ims as ims from '../db/schema';

@path: '/petoberfest-api'
@requires: 'any'
service PetoberfestService {
  @readonly entity Petoberfests as projection on ims.Petoberfests {
    legacyId, slug, title, intro, status
  };

  function slideshow(slug: String) returns array of {
    id: String; petName: String; uploaderName: String; uploadedAt: Timestamp;
  };

  @(requires: 'authenticated-user')
  function myUploads(slug: String) returns array of {
    id: String; petName: String; moderation: String; uploadedAt: Timestamp;
  };
}
