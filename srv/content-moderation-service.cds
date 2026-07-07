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

// ---- FE V4 UI annotations for the admin content moderation surface (#1034) ----

annotate ContentModerationService.NewsItems with @(
  UI.HeaderInfo: {
    TypeName:       'News Item',
    TypeNamePlural: 'News Items',
    Title:          { Value: title },
    Description:    { Value: aiReason }
  },
  UI.SelectionFields: [ aiVerdict, adminVerdict, language, publishedAt ],
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: title,           Label: 'Title' },
    { $Type: 'UI.DataField', Value: publishedAt,     Label: 'Published' },
    { $Type: 'UI.DataField', Value: language,        Label: 'Language' },
    {
      $Type: 'UI.DataField',
      Value: aiVerdict,
      Label: 'AI verdict',
      Criticality: { $edmJson: { $If: [
        { $Eq: [ { $Path: 'aiVerdict' }, 'relevant' ] },   3,
        { $If: [
          { $Eq: [ { $Path: 'aiVerdict' }, 'not-relevant' ] }, 2,
          { $If: [
            { $Eq: [ { $Path: 'aiVerdict' }, 'pending' ] }, 5,
            1
          ] }
        ] }
      ] } }
    },
    { $Type: 'UI.DataField', Value: aiReason,        Label: 'AI reason' },
    { $Type: 'UI.DataField', Value: aiVerdictSource, Label: 'Source' },
    { $Type: 'UI.DataField', Value: aiConfidence,    Label: 'Confidence' },
    { $Type: 'UI.DataField', Value: adminVerdict,    Label: 'Admin verdict' },
    { $Type: 'UI.DataField', Value: adminNote,       Label: 'Admin note' },
    { $Type: 'UI.DataField', Value: aiVerdictAt,     Label: 'Last classified' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.NewsItems/approve',       Label: 'Approve' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.NewsItems/reject',        Label: 'Reject' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.NewsItems/clearOverride', Label: 'Clear override' },
    { $Type: 'UI.DataFieldForAction', Action: 'ContentModerationService.NewsItems/reclassify',    Label: 'Reclassify' }
  ]
);

annotate ContentModerationService.RelevanceSeedExemplars with @(
  UI.HeaderInfo: {
    TypeName:       'Seed',
    TypeNamePlural: 'Seeds',
    Title:          { Value: label }
  },
  UI.SelectionFields: [ label, active ],
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: label,      Label: 'Label' },
    { $Type: 'UI.DataField', Value: text,       Label: 'Text' },
    { $Type: 'UI.DataField', Value: active,     Label: 'Active' },
    { $Type: 'UI.DataField', Value: note,       Label: 'Note' },
    { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified' },
    { $Type: 'UI.DataField', Value: modifiedBy, Label: 'Modified by' }
  ]
);
