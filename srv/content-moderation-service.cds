using { com.sap.developers.ims.external } from '../db/external-content';

/**
 * #1034 Admin moderation surface for content sources that ship to the homepage
 * behind a developer-relevance classifier. NewsItems is populated by
 * fetch-news-job. RelevanceSeedExemplars are the classifier's shared seed
 * exemplars. BlogPosts projection intentionally omitted until #1033 lands.
 *
 * All entity reads gated at Tutorial.Author; write actions gated at
 * internal.SuperAdmin. Draft NOT enabled — actions immediate-save.
 */
@path: '/content-moderation'
@requires: 'Tutorial.Author'
service ContentModerationService {

  @readonly
  entity NewsItems as projection on external.NewsItems actions {
    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action approve(note: String(500));

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action reject(note: String(500));

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action clearOverride();

    @(restrict: [{ grant: '*', to: 'internal.SuperAdmin' }])
    action reclassify();
  };

  // BlogPosts projection deliberately omitted — #1033 introduces the
  // underlying entity and will add its own projection when it lands.

  @(restrict: [
    { grant: 'READ',                              to: 'Tutorial.Author'      },
    { grant: ['CREATE','UPDATE','DELETE'],        to: 'internal.SuperAdmin'  },
  ])
  entity RelevanceSeedExemplars as projection on external.RelevanceSeedExemplars
    excluding { embedding };
}
