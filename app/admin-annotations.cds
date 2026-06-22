// app/admin-annotations.cds
using AdminService from '../srv/admin-service';

// --- Draft Enablement ---
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;
annotate AdminService.Prizes with @odata.draft.enabled;
annotate AdminService.Tutorials with @odata.draft.enabled;

// --- Events ---
annotate AdminService.Events with {
  legacyIdStr  @Common.Label: 'Event ID' @Common.IsDigitSequence: true;
  name      @Common.Label: 'Name'
            // Self-referential value help on the SelectionFields filter so users
            // pick from existing event names instead of typing free-form. The
            // legacyId + startDate display-only columns disambiguate events that
            // share a base name across years (e.g. multiple "TechEd" rows).
            @Common.ValueList: {
              CollectionPath: 'Events',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: name, ValueListProperty: 'name' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' }
              ]
            };
  startDate @Common.Label: 'Start Date';
  endDate   @Common.Label: 'End Date';
  timeZone  @Common.Label: 'Time Zone'
            @Common.ValueList: {
              CollectionPath: 'TimeZones',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: timeZone, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'utcOffset' }
              ]
            };
};

annotate AdminService.Events with @UI: {
  HeaderInfo: {
    TypeName: 'Event', TypeNamePlural: 'Events',
    Title: { Value: name },
    Description: { Value: timeZone }
  },
  SelectionFields: [ name, startDate, endDate ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: name },
    { Value: startDate },
    { Value: endDate },
    { Value: timeZone }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General Information' },
    { $Type: 'UI.ReferenceFacet', Target: 'prizes/@UI.LineItem', Label: 'Prizes' }
  ],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: startDate },
    { Value: endDate },
    { Value: timeZone }
  ]}
};

// --- Missions ---
annotate AdminService.Missions with {
  legacyIdStr        @Common.Label: 'Mission ID' @Common.IsDigitSequence: true;
  title              @Common.Label: 'Title'  @mandatory;
  description        @Common.Label: 'Description'  @mandatory  @UI.MultiLineText;
  slug               @Common.Label: 'Slug';
  communityMissionId @Common.Label: 'Mission ID in Community';
  experienceTag      @Common.Label: 'Experience'  @Common.ValueListWithFixedValues  @mandatory;
  primaryTag         @Common.Label: 'Primary Tag (text)';
  primaryTagRef      @Common.Label: 'Primary Tag'  @mandatory
                     @Common.Text: primaryTagRef.name  @Common.TextArrangement: #TextOnly;
  missionType        @Common.Label: 'Type'  @Common.ValueListWithFixedValues;
  event              @Common.Label: 'Event';
  published          @Common.Label: 'Published';
  status             @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
  averageTimeToComplete @Common.Label: 'Avg Time (min)';
};

annotate AdminService.Missions with @UI: {
  HeaderInfo: {
    TypeName: 'Mission', TypeNamePlural: 'Missions',
    Title: { Value: title },
    Description: { Value: experienceTag }
  },
  SelectionFields: [ title, experienceTag, status ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: title },
    { Value: slug },
    { Value: experienceTag },
    { Value: primaryTagRef.name, Label: 'Primary Tag' },
    { Value: published, @UI.Importance: #High },
    { Value: status }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General' },
    { $Type: 'UI.ReferenceFacet', Target: 'tags/@UI.LineItem', Label: 'Tags' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Target: 'completionPaths/@UI.LineItem', Label: 'Completion Paths' }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: communityMissionId },
    { Value: description },
    { Value: primaryTagRef_ID, Label: 'Primary Tag' },
    { Value: event_ID, Label: 'Event' },
    { Value: experienceTag },
    { Value: missionType },
    { Value: published, @UI.FieldControl: publishedFieldControl },
    { Value: status }
  ]}
};

annotate AdminService.Missions with {
  // Self-VH on the SelectionFields filter so admins pick from existing missions
  // by title (slug + legacyId disambiguate when titles repeat across years).
  title @Common.ValueList: {
    CollectionPath: 'Missions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: title, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
    ]
  };
  primaryTagRef @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: primaryTagRef_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
    ]
  };
  event @Common.ValueList: {
    CollectionPath: 'Events',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: event_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
    ]
  };
  experienceTag @Common.ValueList: {
    CollectionPath: 'ExperienceLevels',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: experienceTag, ValueListProperty: 'code' }]
  };
  missionType @Common.ValueList: {
    CollectionPath: 'MissionTypes',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: missionType, ValueListProperty: 'code' }]
  };
  status @Common.ValueList: {
    CollectionPath: 'TaskStatuses',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: status, ValueListProperty: 'code' }]
  };
};

// CompletionPaths line items
annotate AdminService.CompletionPaths with {
  name        @Common.Label: 'Title';
  description @Common.Label: 'Description'  @UI.MultiLineText;
  slug        @Common.Label: 'Slug';
};

annotate AdminService.CompletionPaths with @UI: {
  HeaderInfo: {
    TypeName: 'Completion Path', TypeNamePlural: 'Completion Paths',
    Title: { Value: name }
  },
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General' },
    { $Type: 'UI.ReferenceFacet', Target: 'items/@UI.LineItem', Label: 'Path Items' }
  ],
  FieldGroup#General: {
    Data: [
      { Value: name },
      { Value: description }
    ]
  },
  LineItem: [
    { Value: name },
    { Value: slug }
  ]
};

annotate AdminService.CompletionPathItems with {
  taskType        @Common.Label: 'Type'  @Common.ValueListWithFixedValues
                  @Common.ValueList: {
                    CollectionPath: 'TaskTypes',
                    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: taskType, ValueListProperty: 'code' }]
                  };
  tutorial        @Common.Label: 'Tutorial';
  group           @Common.Label: 'Group';
  checkpointTitle @Common.Label: 'Checkpoint';
  prize           @Common.Label: 'Prize';
  taskName        @Common.Label: 'Task'  @UI.HiddenFilter;
  itemOrder       @Common.Label: 'Order';
  altGroupKey     @Common.Label: 'Alt-group key'
                  @Common.QuickInfo: 'Items in this path with the same (key, order) form a pick-one alt-group. Leave blank for linear backbone.';
  altGroupLabel   @Common.Label: 'Alt-group label'
                  @Common.QuickInfo: 'Display text on the alt-group chip (e.g. "HANA Cloud", "On-prem"). Required when key is set.';
  altCondition    @Common.Label: 'Alt-group condition'
                  @Common.QuickInfo: 'Optional predicate (e.g. profile.deployment == ''cloud''). When set, runtime evaluates deterministically; when null, the heuristic ranker decides.'
                  @UI.MultiLineText;
  hideTutorial    @UI.Hidden;
  hideGroup       @UI.Hidden;
  hideCheckpoint  @UI.Hidden;
  showTutorial    @UI.Hidden;
  showGroup       @UI.Hidden;
  showCheckpoint  @UI.Hidden;
};

annotate AdminService.CompletionPathItems with {
  tutorial @Common.Text: tutorial.title @Common.TextArrangement: #TextOnly
           @Common.ValueList: {
             CollectionPath: 'Tutorials',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tutorial_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' }
             ]
           };
  group @Common.Text: group.title @Common.TextArrangement: #TextOnly
        @Common.ValueList: {
          CollectionPath: 'Groups',
          Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: group_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' }
          ]
        };
  prize @Common.Text: prize.name @Common.TextArrangement: #TextOnly
        @Common.ValueList: {
          CollectionPath: 'Prizes',
          Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: prize_ID, ValueListProperty: 'ID' },
            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
          ]
        };
};

annotate AdminService.CompletionPathItems with @UI: {
  HeaderInfo: {
    TypeName: 'Path Item', TypeNamePlural: 'Path Items',
    Title: { Value: taskName },
    Description: { Value: taskType }
  },
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#TaskDetails', Label: 'Task Details' }
  ],
  FieldGroup#TaskDetails: {
    Data: [
      { Value: taskType },
      { Value: tutorial_ID, ![@UI.Hidden]: { $edmJson: { $Path: 'hideTutorial' }} },
      { Value: group_ID, ![@UI.Hidden]: { $edmJson: { $Path: 'hideGroup' }} },
      { Value: checkpointTitle, ![@UI.Hidden]: { $edmJson: { $Path: 'hideCheckpoint' }} },
      { Value: prize_ID },
      { Value: altGroupKey },
      { Value: altGroupLabel },
      { Value: altCondition }
    ]
  },
  PresentationVariant: { SortOrder: [ { Property: itemOrder } ] },
  LineItem: [
    // Editable Order column — admins type a new order number to reorder rows.
    // The PresentationVariant.SortOrder above re-sorts on next page load.
    { Value: itemOrder, Label: 'Order' },
    // Type + Task columns are added via manifest.json controlConfiguration
    // (TypeColumn + TaskColumn templates with their working inline-edit handler).
    { Value: prize_ID, Label: 'Prize' },
    { Value: altGroupKey, Label: 'Alt key' },
    { Value: altGroupLabel, Label: 'Alt label' }
  ]
};


// --- Groups ---
annotate AdminService.Groups with {
  legacyIdStr           @Common.Label: 'Group ID' @Common.IsDigitSequence: true;
  title                 @Common.Label: 'Title'  @mandatory;
  description           @Common.Label: 'Description'  @mandatory  @UI.MultiLineText;
  experienceTag         @Common.Label: 'Experience'  @Common.ValueListWithFixedValues  @mandatory;
  primaryTag            @Common.Label: 'Primary Tag (text)';
  primaryTagRef         @Common.Label: 'Primary Tag'  @mandatory
                        @Common.Text: primaryTagRef.name  @Common.TextArrangement: #TextOnly;
  averageTimeToComplete @Common.Label: 'Avg Time (min)';
  published             @Common.Label: 'Published';
  status                @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
};

annotate AdminService.Groups with @UI: {
  HeaderInfo: {
    TypeName: 'Group', TypeNamePlural: 'Groups',
    Title: { Value: title },
    Description: { Value: experienceTag }
  },
  SelectionFields: [ title, experienceTag ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: title },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: published, @UI.Importance: #High },
    { Value: status }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General' },
    { $Type: 'UI.ReferenceFacet', Target: 'items/@UI.LineItem', Label: 'Path Items', ID: 'PathItemsSection' },
    { $Type: 'UI.ReferenceFacet', Target: 'tags/@UI.LineItem', Label: 'Tags' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: description },
    { Value: primaryTagRef_ID, Label: 'Primary Tag' },
    { Value: experienceTag },
    { Value: published, @UI.FieldControl: publishedFieldControl },
    { Value: status }
  ]}
};

annotate AdminService.Groups with {
  // Self-VH on the SelectionFields filter so admins pick from existing groups
  // by title; legacyId disambiguates duplicates.
  title @Common.ValueList: {
    CollectionPath: 'Groups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: title, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
    ]
  };
  primaryTagRef @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: primaryTagRef_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
    ]
  };
  experienceTag @Common.ValueList: {
    CollectionPath: 'ExperienceLevels',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: experienceTag, ValueListProperty: 'code' }]
  };
  status @Common.ValueList: {
    CollectionPath: 'TaskStatuses',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: status, ValueListProperty: 'code' }]
  };
};

// GroupTags — inline table with value help for tag selection
annotate AdminService.GroupTags with {
  tag @Common.Label: 'Tag'
      @Common.Text: tag.name  @Common.TextArrangement: #TextOnly
      @Common.ValueList: {
        CollectionPath: 'Tags',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tag_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
        ]
      };
};

annotate AdminService.GroupTags with @UI: {
  LineItem: [
    { Value: tag_ID, Label: 'Tag' }
  ]
};

// GroupPathItems — ordered tutorials within a Group (tutorial-only path items)
annotate AdminService.GroupPathItems with {
  itemOrder @Common.Label: 'Order';
  tutorial  @Common.Label: 'Tutorial'  @mandatory
            @Common.Text: tutorial.title  @Common.TextArrangement: #TextOnly
            @Common.ValueList: {
              CollectionPath: 'Tutorials',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tutorial_ID, ValueListProperty: 'ID' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' }
              ]
            };
  altGroupKey     @Common.Label: 'Alt-group key'
                  @Common.QuickInfo: 'Items in this group with the same (key, order) form a pick-one alt-group. Leave blank for linear backbone.';
  altGroupLabel   @Common.Label: 'Alt-group label'
                  @Common.QuickInfo: 'Display text on the alt-group chip (e.g. "HANA Cloud", "On-prem"). Required when key is set.';
  altCondition    @Common.Label: 'Alt-group condition'
                  @Common.QuickInfo: 'Optional predicate (e.g. profile.deployment == ''cloud''). When set, runtime evaluates deterministically; when null, the heuristic ranker decides.'
                  @UI.MultiLineText;
};

annotate AdminService.GroupPathItems with @UI: {
  PresentationVariant: { SortOrder: [ { Property: itemOrder } ] },
  LineItem: [
    { Value: itemOrder },
    { Value: tutorial_ID, Label: 'Tutorial' },
    // Slug as a read-only confirmation column. Pulls from the tutorial association
    // via the V4 model's autoExpandSelect; admins can confirm they picked the right
    // tutorial after editing the Tutorial column (titles can collide; slugs are
    // unique by design).
    { Value: tutorial.slug, Label: 'Slug' },
    { Value: altGroupKey, Label: 'Alt key' },
    { Value: altGroupLabel, Label: 'Alt label' }
  ]
};

// MissionTags — inline table with value help for tag selection
annotate AdminService.MissionTags with {
  tag @Common.Label: 'Tag'
      @Common.Text: tag.name  @Common.TextArrangement: #TextOnly
      @Common.ValueList: {
        CollectionPath: 'Tags',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tag_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
        ]
      };
};

annotate AdminService.MissionTags with @UI: {
  LineItem: [
    { Value: tag_ID, Label: 'Tag' }
  ]
};

// --- Accomplishments ---
annotate AdminService.Accomplishments with {
  legacyIdStr @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name        @Common.Label: 'Name'
              @Common.ValueList: {
                CollectionPath: 'Accomplishments',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: name, ValueListProperty: 'name' },
                  { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
                ]
              };
  description @Common.Label: 'Description';
  rule        @Common.Label: 'Rule (JSON)';
};

annotate AdminService.Accomplishments with @UI: {
  HeaderInfo: {
    TypeName: 'Accomplishment', TypeNamePlural: 'Accomplishments',
    Title: { Value: name },
    Description: { Value: description }
  },
  SelectionFields: [ name ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: name },
    { Value: description }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Details' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: description },
    { Value: rule }
  ]}
};

annotate AdminService.Accomplishments with {
  rule @UI.MultiLineText;
};

// --- Prizes ---
annotate AdminService.Prizes with {
  legacyIdStr @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name     @Common.Label: 'Name';
  event    @Common.Label: 'Event'
           @Common.ValueList: {
             CollectionPath: 'Events',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: event_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' }
             ]
           };
};

annotate AdminService.Prizes with @UI: {
  HeaderInfo: {
    TypeName: 'Prize', TypeNamePlural: 'Prizes',
    Title: { Value: name }
  },
  LineItem: [
    { Value: legacyIdStr },
    { Value: name },
    { Value: event.name, Label: 'Event' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Details' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: event_ID }
  ]}
};

// --- Tutorials (source content from GitHub; Lifecycle fields admin-editable) ---
annotate AdminService.Tutorials with {
  legacyIdStr           @Common.Label: 'Tutorial ID' @Common.IsDigitSequence: true;
  title                 @Common.Label: 'Title'       @Common.FieldControl: #ReadOnly
                        @Common.ValueList: {
                          CollectionPath: 'Tutorials',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: title, ValueListProperty: 'title' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'primaryTag' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
                          ]
                        };
  slug                  @Common.Label: 'Slug'        @Common.FieldControl: #ReadOnly;
  primaryTag            @Common.Label: 'Primary Tag' @Common.FieldControl: #ReadOnly
                        @Common.ValueList: {
                          CollectionPath: 'Tags',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: primaryTag, ValueListProperty: 'name' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'titlePath' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
                          ]
                        };
  experienceTag         @Common.Label: 'Experience'  @Common.ValueListWithFixedValues @Common.FieldControl: #ReadOnly;
  averageTimeToComplete @Common.Label: 'Avg Time (min)' @Common.FieldControl: #ReadOnly;
  status                @Common.Label: 'Status'  @Common.ValueListWithFixedValues
                        @Common.ValueList: {
                          CollectionPath: 'TaskStatuses',
                          Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: status, ValueListProperty: 'code' }]
                        };
  deletionReason        @Common.Label: 'Deletion Reason';
  redirectTo            @Common.Label: 'Redirect To'
                        @Common.Text: redirectTo.title
                        @Common.TextArrangement: #TextOnly
                        @Common.ValueList: {
                          CollectionPath: 'TutorialPickList',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: redirectTo_ID, ValueListProperty: 'ID' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'primaryTag' }
                          ]
                        };
};

annotate AdminService.TutorialMeta with {
  owner @Common.Label: 'Owner' @Common.FieldControl: #ReadOnly
        @Common.ValueList: {
          CollectionPath: 'TutorialOwnerPickList',
          Parameters: [
            { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: owner, ValueListProperty: 'owner' }
          ]
        };
};

annotate AdminService.Tutorials with @UI: {
  HeaderInfo: {
    TypeName: 'Tutorial', TypeNamePlural: 'Tutorials',
    Title: { Value: title },
    Description: { Value: slug }
  },
  SelectionFields: [ title, primaryTag, experienceTag, status, meta.owner ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: status },
    { Value: meta.owner, Label: 'Owner' },
    { Value: redirectTo.title, Label: 'Redirect To' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',  Label: 'General',  Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.CollectionFacet', ID: 'Feedback', Label: 'Feedback', Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackSummary',
        Target: 'feedbackSummary/@UI.FieldGroup#FeedbackSummary',
        Label:  'Summary' },
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackItems',
        Target: 'feedbackItems/@UI.LineItem#TutorialFeedback',
        Label:  'Recent Submissions' }
    ]}
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: meta.owner, Label: 'Owner' }
  ]},
  FieldGroup#Lifecycle: { Data: [
    { Value: status },
    { Value: deletionReason },
    { Value: redirectTo_ID, Label: 'Redirect To' }
  ]}
};

annotate AdminService.Tutorials with {
  feedbackItems @(
    Capabilities.TopSupported: true,
    UI.PresentationVariant: {
      MaxItems: 50,
      SortOrder: [ { Property: submittedAt, Descending: true } ],
      Visualizations: [ '@UI.LineItem#TutorialFeedback' ]
    }
  );
};

// --- TutorialPickList (value-help target for redirectTo) ---
annotate AdminService.TutorialPickList with {
  legacyIdStr   @Common.Label: 'Tutorial ID' @Common.IsDigitSequence: true;
  title      @Common.Label: 'Title';
  slug       @Common.Label: 'Slug';
  primaryTag @Common.Label: 'Primary Tag';
};

annotate AdminService.TutorialPickList with @(
  UI: {
    HeaderInfo: { TypeName: 'Tutorial', TypeNamePlural: 'Tutorials', Title: { Value: title } },
    SelectionFields: [ title, primaryTag ],
    LineItem: [
      { Value: legacyIdStr },
      { Value: title },
      { Value: slug },
      { Value: primaryTag }
    ]
  }
);

// --- Tags (Display Label inline-editable; rest read-only) ---
annotate AdminService.Tags with {
  legacyIdStr  @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name      @Common.Label: 'Internal Name'
            @Common.ValueList: {
              CollectionPath: 'Tags',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: name, ValueListProperty: 'name' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'titlePath' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
              ]
            };
  label     @Common.Label: 'Display Label';
  titlePath @Common.Label: 'Full Path';
  mdFormat  @Common.Label: 'MD Format';
};

annotate AdminService.Tags with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Tag', TypeNamePlural: 'Tags',
      Title: { Value: name }
    },
    SelectionFields: [ name ],
    LineItem: [
      { Value: legacyIdStr },
      { Value: name },
      { Value: label },
      { Value: mdFormat },
      { Value: titlePath }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: true
);

// --- FeaturedTasks (inline editing of featuredOrder) ---
annotate AdminService.FeaturedTasks with {
  taskLegacyId  @Common.Label: 'Task ID';
  taskType      @Common.Label: 'Type'
                @Common.ValueListWithFixedValues
                @Common.ValueList: {
                  CollectionPath: 'AnalyticsTaskTypes',  // reuse existing TUTORIAL/MISSION/GROUP code list (srv/admin-service.js:48)
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskType, ValueListProperty: 'code'  },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                  ]
                };
  featuredOrder @Common.Label: 'Order';
};

annotate AdminService.FeaturedTasks with @UI: {
  HeaderInfo: {
    TypeName: 'Featured Task', TypeNamePlural: 'Featured Tasks',
    Title: { Value: taskLegacyId }
  },
  SelectionFields: [ taskType ],
  LineItem: [
    { Value: taskLegacyId },
    { Value: taskType },
    { Value: featuredOrder, ![@UI.Importance]: #High }
  ]
};

// --- ImsConfig (key/value CRUD) ---
annotate AdminService.ImsConfig with {
  ![key] @Common.Label: 'Key';
  value  @Common.Label: 'Value';
};

annotate AdminService.ImsConfig with @UI: {
  HeaderInfo: {
    TypeName: 'Configuration', TypeNamePlural: 'Configurations',
    Title: { Value: ![key] }
  },
  SelectionFields: [ ![key] ],
  LineItem: [
    { Value: ![key] },
    { Value: value }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Configuration' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: ![key] },
    { Value: value }
  ]}
};

// --- StepFailures (read-only, filterable) ---
annotate AdminService.StepFailures with {
  stepNumber   @Common.Label: 'Step #';
  errorMessage @Common.Label: 'Error';
  failureDate  @Common.Label: 'Date';
};

annotate AdminService.StepFailures with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Step Failure', TypeNamePlural: 'Step Failures',
      Title: { Value: stepNumber }
    },
    SelectionFields: [ failureDate ],
    LineItem: [
      { Value: stepNumber },
      { Value: errorMessage },
      { Value: failureDate }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- NGDSFailedMessages (read-only, retry action per row) ---
annotate AdminService.NGDSFailedMessages with {
  status       @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
  errorMessage @Common.Label: 'Error';
  createdAt    @Common.Label: 'Failed At';
  retryCount   @Common.Label: 'Retries';
};

annotate AdminService.NGDSFailedMessages with @(
  UI: {
    HeaderInfo: {
      TypeName: 'NGDS Failed Message', TypeNamePlural: 'NGDS Failed Messages',
      Title: { Value: ID }
    },
    SelectionFields: [ status ],
    LineItem: [
      { Value: ID, Label: 'ID' },
      { Value: status },
      { Value: errorMessage },
      { Value: retryCount },
      { Value: createdAt }
    ]
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- FailedEmails (read-only, deletable) ---
annotate AdminService.FailedEmails with {
  to           @Common.Label: 'Recipient';
  subject      @Common.Label: 'Subject';
  createdAt    @Common.Label: 'Failed At';
  retryCount   @Common.Label: 'Retries';
  status       @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
};

annotate AdminService.FailedEmails with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Failed Email', TypeNamePlural: 'Failed Emails',
      Title: { Value: subject }
    },
    SelectionFields: [ createdAt, status ],
    LineItem: [
      { Value: to },
      { Value: subject },
      { Value: status },
      { Value: retryCount },
      { Value: createdAt }
    ]
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- PipelineLog (content pipeline only — excludes SCHEDULED_JOB) ---
annotate AdminService.PipelineLog with {
  pipelineType  @Common.Label: 'Type'
                @Common.ValueListWithFixedValues
                @Common.ValueList: {
                  CollectionPath: 'PipelineTypes',
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: pipelineType, ValueListProperty: 'code'  },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                                  ValueListProperty: 'label' }
                  ]
                };
  status        @Common.Label: 'Status'
                @Common.ValueListWithFixedValues
                @Common.ValueList: {
                  CollectionPath: 'PipelineStatuses',
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: status, ValueListProperty: 'code'  },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' }
                  ]
                };
  startedAt     @Common.Label: 'Started';
  finishedAt    @Common.Label: 'Finished';
  durationMs    @Common.Label: 'Duration (ms)';
  initiator     @Common.Label: 'Initiator';
  summary       @Common.Label: 'Summary';
  errorDetails  @Common.Label: 'Error Details'  @UI.MultiLineText;
  metadata      @Common.Label: 'Metadata'       @UI.MultiLineText;
  cfLogsUrl     @Common.Label: 'CF Logs';
};

annotate AdminService.PipelineLog with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Pipeline Log', TypeNamePlural: 'Pipeline Logs',
      Title: { Value: pipelineType },
      Description: { Value: summary }
    },
    SelectionFields: [ pipelineType, status, startedAt ],
    LineItem: [
      { Value: startedAt },
      { Value: pipelineType },
      { Value: status, Criticality: statusCriticality },
      { Value: durationMs },
      { Value: initiator },
      { Value: summary }
    ],
    Sort: [{ Property: startedAt, Descending: true }],
    Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineGeneral', Target: '@UI.FieldGroup#General', Label: 'General' },
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineTiming',  Target: '@UI.FieldGroup#Timing',  Label: 'Timing' },
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineSummary', Target: '@UI.FieldGroup#Summary', Label: 'Summary' },
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineError',   Target: '@UI.FieldGroup#Error',   Label: 'Error Details' },
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineItems',   Target: 'items/@UI.LineItem',     Label: 'Affected Tutorials' },
      { $Type: 'UI.ReferenceFacet', ID: 'PipelineMeta',    Target: '@UI.FieldGroup#Metadata', Label: 'Metadata' }
    ],
    FieldGroup #General: { Data: [
      { Value: pipelineType },
      { Value: status, Criticality: statusCriticality },
      { Value: initiator },
      // CF Logs link: opens this run's window in the BTP Cloud Logging
      // dashboard (Kibana-style Discover view filtered to ±10s/30s around
      // startedAt/finishedAt). Auth is the same SAP IDP / XSUAA session
      // that holds /admin-ui/ — clicking redirects through your active
      // session, no separate login. Use for raw stdout/stderr drilldown;
      // for THIS run's own details, see the Summary, Affected Tutorials,
      // and Metadata facets below.
      { $Type: 'UI.DataFieldWithUrl', Label: 'CF Logs (raw app stdout)', Value: cfLogsUrl, Url: cfLogsUrl }
    ]},
    FieldGroup #Timing: { Data: [
      { Value: startedAt },
      { Value: finishedAt },
      { Value: durationMs }
    ]},
    FieldGroup #Summary:  { Data: [{ Value: summary }] },
    FieldGroup #Error:    { Data: [{ Value: errorDetails }] },
    FieldGroup #Metadata: { Data: [{ Value: metadata }] }
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- PipelineLogItems (per-slug failures captured during a pipeline run) ---
annotate AdminService.PipelineLogItems with {
  slug     @Common.Label: 'Tutorial Slug';
  phase    @Common.Label: 'Phase'    @Common.ValueListWithFixedValues;
  severity @Common.Label: 'Severity' @Common.ValueListWithFixedValues;
  message  @Common.Label: 'Message'  @UI.MultiLineText;
};

annotate AdminService.PipelineLogItems with @(
  UI: {
    LineItem: [
      { Value: severity, Criticality: severityCriticality },
      { Value: phase },
      { Value: slug },
      { Value: message }
    ],
    SelectionFields: [ severity, phase ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- JobExecutionLog (scheduled jobs only) ---
annotate AdminService.JobExecutionLog with {
  status        @Common.Label: 'Status'
                @Common.ValueListWithFixedValues
                @Common.ValueList: {
                  CollectionPath: 'PipelineStatuses',
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: status, ValueListProperty: 'code'  },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' }
                  ]
                };
  startedAt     @Common.Label: 'Started';
  finishedAt    @Common.Label: 'Finished';
  durationMs    @Common.Label: 'Duration (ms)';
  initiator     @Common.Label: 'Instance';
  summary       @Common.Label: 'Job Name';
  errorDetails  @Common.Label: 'Error'  @UI.MultiLineText;
  metadata      @Common.Label: 'Metadata'  @UI.MultiLineText;
  cfLogsUrl     @Common.Label: 'CF Logs';
};

annotate AdminService.JobExecutionLog with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Job Execution', TypeNamePlural: 'Job Executions',
      Title: { Value: summary },
      Description: { Value: status }
    },
    SelectionFields: [ status, startedAt ],
    LineItem: [
      { Value: startedAt },
      { Value: summary },
      { Value: status, Criticality: statusCriticality },
      { Value: durationMs },
      { Value: initiator },
      { Value: errorDetails }
    ],
    Sort: [{ Property: startedAt, Descending: true }],
    Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'JobGeneral', Target: '@UI.FieldGroup#General', Label: 'General' },
      { $Type: 'UI.ReferenceFacet', ID: 'JobTiming',  Target: '@UI.FieldGroup#Timing',  Label: 'Timing' },
      { $Type: 'UI.ReferenceFacet', ID: 'JobItems',   Target: 'jobItems/@UI.LineItem',  Label: 'Job Output' },
      { $Type: 'UI.ReferenceFacet', ID: 'JobError',   Target: '@UI.FieldGroup#Error',   Label: 'Error Details' },
      { $Type: 'UI.ReferenceFacet', ID: 'JobMeta',    Target: '@UI.FieldGroup#Metadata', Label: 'Metadata' }
    ],
    FieldGroup #General: { Data: [
      { Value: summary },
      { Value: status, Criticality: statusCriticality },
      { Value: initiator },
      // CF Logs link: opens this run's window in the BTP Cloud Logging
      // dashboard. SAP IDP / XSUAA SSO (same session as /admin-ui/).
      // Use for raw stdout/stderr drilldown; for THIS run's own details,
      // see the Summary, Job Output, and Metadata facets below.
      { $Type: 'UI.DataFieldWithUrl', Label: 'CF Logs (raw app stdout)', Value: cfLogsUrl, Url: cfLogsUrl }
    ]},
    FieldGroup #Timing: { Data: [
      { Value: startedAt },
      { Value: finishedAt },
      { Value: durationMs }
    ]},
    FieldGroup #Error:    { Data: [{ Value: errorDetails }] },
    FieldGroup #Metadata: { Data: [{ Value: metadata }] }
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- JobLogItems (per-record output captured during a scheduled-job run) ---
annotate AdminService.JobLogItems with {
  itemKey  @Common.Label: 'Item';
  itemKind @Common.Label: 'Kind'    @Common.ValueListWithFixedValues;
  status   @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
  message  @Common.Label: 'Message' @UI.MultiLineText;
};

annotate AdminService.JobLogItems with @(
  UI: {
    LineItem: [
      { Value: status, Criticality: statusCriticality },
      { Value: itemKind },
      { Value: itemKey },
      { Value: message }
    ],
    SelectionFields: [ status, itemKind ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// ChangeView: plugin provides LineItem, PresentationVariant, FieldGroups, Hierarchy, Search.
// ReadRestrictions override is applied at runtime in srv/admin-service.js.
// We add SelectionFields for the standalone ListReport filter bar.
// Must target sap.changelog.ChangeView (the base) since AdminService.ChangeView is injected at runtime.
using { sap.changelog.ChangeView } from '@cap-js/change-tracking';
annotate ChangeView with @UI.SelectionFields: [
  entityLabel,
  modificationLabel,
  createdBy,
  createdAt
];

// --- PrimaryAccounts / SecondaryAccounts (account-merge audit log, read-only) ---
annotate AdminService.PrimaryAccounts with {
  uuid   @Common.Label: 'Primary UUID';
  status @Common.Label: 'Status'
         @Common.ValueListWithFixedValues
         @Common.ValueList: {
           CollectionPath: 'AccountMergeStatuses',
           Parameters: [
             { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: status, ValueListProperty: 'code'  },
             { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' }
           ]
         };
};

annotate AdminService.PrimaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Account Merge', TypeNamePlural: 'Account Merges',
      Title: { Value: uuid }
    },
    SelectionFields: [ uuid, status ],
    LineItem: [
      { Value: uuid },
      { Value: status }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.SecondaryAccounts with {
  uuid              @Common.Label: 'Secondary UUID';
  // The Association field itself (not the FK) — admins typically want the
  // parent's UUID, which is reachable via `primaryAccount.uuid`. The raw
  // `primaryAccount_ID` FK column exists in OData $metadata but is not a
  // CSN element on the projection (caught by compiler warning).
  primaryAccount    @Common.Label: 'Merged Into';
  status            @Common.Label: 'Status'
                    @Common.ValueListWithFixedValues
                    @Common.ValueList: {
                      CollectionPath: 'AccountMergeStatuses',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: status, ValueListProperty: 'code'  },
                        { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' }
                      ]
                    };
  mergedAt          @Common.Label: 'Merged At';
};

annotate AdminService.SecondaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Merged Secondary', TypeNamePlural: 'Merged Secondaries',
      Title: { Value: uuid }
    },
    SelectionFields: [ uuid, status ],
    LineItem: [
      { Value: uuid },
      { Value: primaryAccount.uuid, Label: 'Primary UUID' },
      { Value: status },
      { Value: mergedAt }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- Completion Analytics (aggregated report, no user data) ---

annotate AdminService.CompletionAnalytics with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby', 'concat'],
    GroupableProperties: [
      completionDay,
      completionDate,
      taskType,
      taskTitle,
      primaryTag,
      experienceTag,
      groupTitle,
      missionTitle,
      eventName
    ],
    AggregatableProperties: [
      { Property: completionCount },
      { Property: completionTimeMs }
    ]
  },
  Analytics.AggregatedProperty #totalCompletions: {
    Name: 'totalCompletions',
    AggregationMethod: 'sum',
    AggregatableProperty: completionCount,
    ![@Common.Label]: 'Completions'
  },
  UI.Chart: {
    ChartType: #Line,
    Dimensions: [completionDay, taskType],
    DynamicMeasures: ['@Analytics.AggregatedProperty#totalCompletions']
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: completionDate, Descending: true }]
  },
  UI.SelectionFields: [taskType, primaryTag, experienceTag, completionDate, missionTitle, groupTitle, eventName],
  UI.LineItem: [
    { Value: completionDate },
    { Value: taskType },
    { Value: taskTitle },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: missionTitle },
    { Value: groupTitle },
    { Value: eventName },
    { Value: completionCount, Label: 'Completions' }
  ]
) {
  ID              @UI.Hidden;
  taskType        @title: 'Task Type'            @Analytics.Dimension;
  completionDate  @title: 'Completion Date'      @Analytics.Dimension;
  completionDay   @title: 'Completion Day'       @Analytics.Dimension;
  taskTitle       @title: 'Task'                 @Analytics.Dimension;
  primaryTag      @title: 'Primary Tag'          @Analytics.Dimension;
  experienceTag   @title: 'Level'                @Analytics.Dimension;
  groupTitle      @title: 'Group'                @Analytics.Dimension;
  missionTitle    @title: 'Mission'              @Analytics.Dimension;
  eventName       @title: 'Event'                @Analytics.Dimension;
  completionTimeMs @title: 'Completion Time (ms)' @Analytics.Measure @Aggregation.default: #SUM;
  completionCount @title: 'Completions'          @Analytics.Measure @Aggregation.default: #SUM;
};

// Value help for filter fields. CompletionAnalytics carries denormalized strings
// (titles/names), not associations — so each LocalDataProperty maps the analytics
// string column to the matching string on the source entity, and a DisplayOnly
// parameter provides the readable secondary text (slug, titlePath, dates).
annotate AdminService.CompletionAnalytics with {
  taskType @Common.ValueListWithFixedValues @Common.ValueList: {
    CollectionPath: 'AnalyticsTaskTypes',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskType, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
    ]
  };
  experienceTag @Common.ValueListWithFixedValues @Common.ValueList: {
    CollectionPath: 'AnalyticsLevels',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: experienceTag, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
    ]
  };
  primaryTag @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: primaryTag, ValueListProperty: 'name' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'titlePath' }
    ]
  };
  missionTitle @Common.ValueList: {
    CollectionPath: 'Missions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: missionTitle, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' }
    ]
  };
  groupTitle @Common.ValueList: {
    CollectionPath: 'Groups',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: groupTitle, ValueListProperty: 'title' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' }
    ]
  };
  eventName @Common.ValueList: {
    CollectionPath: 'Events',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: eventName, ValueListProperty: 'name' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' }
    ]
  };
};

// --- Joule Chat Settings (singleton) ---
annotate AdminService.ChatSettings with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'Joule Chat Settings',
      TypeNamePlural : 'Joule Chat Settings',
      Title          : { Value: bannerText }
    },
    Facets: [{
      $Type  : 'UI.ReferenceFacet',
      Label  : 'General',
      Target : '@UI.FieldGroup#General'
    }],
    FieldGroup #General: {
      Data: [
        { Value: enabled },
        { Value: deploymentId },
        { Value: modelName },
        { Value: temperature },
        { Value: maxTokens },
        { Value: maxRequestsPerUser },
        { Value: bannerText }
      ]
    }
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable: false
) {
  enabled            @Common.Label: 'Enabled' @description: 'Master kill-switch. When off, the Joule button is hidden and /chat/stream returns 503.';
  deploymentId       @Common.Label: 'AI Core Deployment ID' @description: 'Orchestration deployment from SAP AI Core Generative AI Hub.';
  modelName          @Common.Label: 'Model Name' @description: 'Foundation model name routed by the orchestration deployment (e.g. anthropic--claude-4.6-sonnet, gpt-4.1). Leave blank for server default.';
  temperature        @Common.Label: 'Temperature' @description: 'Sampling temperature 0.00 (deterministic) to 1.00 (creative). Leave blank for server default (0.51).' @assert.range: [0.00, 1.00];
  maxTokens          @Common.Label: 'Max Tokens' @description: 'Cap on tokens in a single assistant response. Leave blank for server default (10025).' @assert.range: [1, 100000];
  maxRequestsPerUser @Common.Label: 'Max Requests / User / Day' @description: 'In-memory rolling 24h limit, per service instance. Effective ceiling = this × instance count.';
  bannerText         @Common.Label: 'Banner Text'   @description: 'Optional notice shown above the chat input (e.g. "Joule is in beta").' @UI.MultiLineText;
  ragEnabled         @Common.Label: 'RAG Enabled';
  embeddingModel     @Common.Label: 'Embedding Model';
  embeddingTopK      @Common.Label: 'Top K Steps';
  embeddingMinScore  @Common.Label: 'Min Similarity Score';
};

annotate AdminService.TutorialFeedback with {
  tutorialSlug @Common.Label: 'Tutorial'
               @Common.ValueList: {
                 CollectionPath: 'Tutorials',
                 Parameters: [
                   { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: tutorialSlug, ValueListProperty: 'slug' },
                   { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' },
                   { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'primaryTag' }
                 ]
               };
};

annotate AdminService.TutorialFeedback with @(
  Capabilities.InsertRestrictions: { Insertable: false },
  Capabilities.UpdateRestrictions: { Updatable: false },
  Capabilities.DeleteRestrictions: { Deletable: false },
  UI.HeaderInfo: {
    TypeName: 'Submission',
    TypeNamePlural: 'Submissions',
    Title: { Value: tutorialSlug }
  },
  UI.SelectionFields: [tutorialSlug, wasAuthenticated, submittedAt],
  UI.LineItem: [
    { Value: tutorialSlug },
    { Value: submittedAt },
    { Value: wasAuthenticated },
    { Value: npsScore },
    { Value: ratingUseCase },
    { Value: ratingRelevance },
    { Value: ratingDuration },
    { Value: ratingStructure },
    { Value: ratingInteresting },
    { Value: ratingVisuals },
    { Value: comment }
  ],
  UI.FieldGroup #Ratings: { Data: [
    { Value: ratingUseCase },
    { Value: ratingRelevance },
    { Value: ratingDuration },
    { Value: ratingStructure },
    { Value: ratingInteresting },
    { Value: ratingVisuals },
    { Value: npsScore }
  ]},
  UI.FieldGroup #CommentGroup: { Data: [{ Value: comment }] },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Ratings', Target: '@UI.FieldGroup#Ratings' },
    { $Type: 'UI.ReferenceFacet', Label: 'Comment', Target: '@UI.FieldGroup#CommentGroup' }
  ]
);

// --- Tutorials feedback (#95): aggregate summary + per-row line item ---
annotate AdminService.TutorialFeedbackAggregate with @UI: {
  FieldGroup #FeedbackSummary: { Data: [
    { Value: responseCount,  Label: 'Responses' },
    { Value: avgNps,         Label: 'Avg NPS' },
    { Value: promoters,      Label: 'Promoters' },
    { Value: detractors,     Label: 'Detractors' },
    { Value: avgUseCase,     Label: 'Avg Use Case' },
    { Value: avgRelevance,   Label: 'Avg Relevance' },
    { Value: avgDuration,    Label: 'Avg Duration' },
    { Value: avgStructure,   Label: 'Avg Structure' },
    { Value: avgInteresting, Label: 'Avg Interesting' },
    { Value: avgVisuals,     Label: 'Avg Visuals' }
  ]}
};

annotate AdminService.TutorialFeedback with @UI: {
  LineItem #TutorialFeedback: [
    { Value: submittedAt,      Label: 'Submitted' },
    { Value: npsScore,         Label: 'NPS' },
    { Value: wasAuthenticated, Label: 'Authenticated' },
    { Value: comment,          Label: 'Comment' },
    { Value: ratingUseCase,    Label: 'Use Case' },
    { Value: ratingRelevance,  Label: 'Relevance' },
    { Value: ratingDuration,   Label: 'Duration' },
    { Value: ratingStructure,  Label: 'Structure' },
    { Value: ratingInteresting,Label: 'Interesting' },
    { Value: ratingVisuals,    Label: 'Visuals' }
  ]
};

// --- Categories (#201) ---
annotate AdminService.Categories with {
  slug            @Common.Label: 'Slug';
  label           @Common.Label: 'Label';
  sortOrder       @Common.Label: 'Sort Order';
  seedDescription @Common.Label: 'Seed Description'  @Common.MultiLineText;
};

annotate AdminService.Categories with @(
  UI.HeaderInfo: {
    TypeName: 'Category',
    TypeNamePlural: 'Categories',
    Title: { Value: label }
  },
  UI.SelectionFields: [ label, slug ],
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
    { $Type: 'UI.DataField', Value: label,           Label: 'Label' },
    { $Type: 'UI.DataField', Value: sortOrder,       Label: 'Sort Order' },
    { $Type: 'UI.DataField', Value: seedDescription, Label: 'Seed Description' }
  ],
  UI.FieldGroup #Main: {
    Data: [
      { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
      { $Type: 'UI.DataField', Value: label,           Label: 'Label' },
      { $Type: 'UI.DataField', Value: sortOrder,       Label: 'Sort Order' },
      { $Type: 'UI.DataField', Value: seedDescription, Label: 'Seed Description' }
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Main', Target: '@UI.FieldGroup#Main' }
  ]
);

annotate AdminService.Categories with {
  slug @UI.HiddenFilter;
};

// --- MissionCategories — inline table + value help for category selection ---
annotate AdminService.MissionCategories with {
  category @Common.Label: 'Category'
           @Common.Text: category.label  @Common.TextArrangement: #TextOnly
           @Common.ValueList: {
             CollectionPath: 'Categories',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: category_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
             ]
           };
  score    @Common.Label: 'Score';
};

annotate AdminService.MissionCategories with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: category_ID, Label: 'Category' },
    { $Type: 'UI.DataField', Value: score,        Label: 'Score' }
  ]
};

// --- GroupCategories — inline table + value help for category selection ---
annotate AdminService.GroupCategories with {
  category @Common.Label: 'Category'
           @Common.Text: category.label  @Common.TextArrangement: #TextOnly
           @Common.ValueList: {
             CollectionPath: 'Categories',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: category_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
             ]
           };
  score    @Common.Label: 'Score';
};

annotate AdminService.GroupCategories with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: category_ID, Label: 'Category' },
    { $Type: 'UI.DataField', Value: score,        Label: 'Score' }
  ]
};

// --- TutorialCategories — inline table + value help for category selection ---
annotate AdminService.TutorialCategories with {
  category @Common.Label: 'Category'
           @Common.Text: category.label  @Common.TextArrangement: #TextOnly
           @Common.ValueList: {
             CollectionPath: 'Categories',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: category_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
             ]
           };
  score    @Common.Label: 'Score';
};

annotate AdminService.TutorialCategories with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: category_ID, Label: 'Category' },
    { $Type: 'UI.DataField', Value: score,        Label: 'Score' }
  ]
};

// Issue #172 PR 5 — branch performance LineItem rendered inside the
// Missions ObjectPage as an additional section (manifest extension wires
// the OData URL with $filter=missionSlug eq <current>).
// Spec: §4.3 Mission ObjectPage section + §4.1 view shape.
using AnalyticsService from '../srv/analytics-service';

annotate AnalyticsService.AnalyticsBranchPerformance with @(
  UI.HeaderInfo: {
    TypeName: 'Branch Decision', TypeNamePlural: 'Branch Decisions',
    Title: { Value: branchPointId }
  },
  UI.LineItem: [
    { Value: branchPointId,    Label: 'Branch Point' },
    { Value: tutorialSlug,     Label: 'Tutorial' },
    { Value: surface,          Label: 'Surface' },
    { Value: total,            Label: 'Total Decisions' },
    { Value: clickedTotal,     Label: 'Clicks' },
    { Value: followed,         Label: 'Followed' },
    { Value: byCondition,      Label: 'By Condition' },
    { Value: byRanker,         Label: 'By Ranker' },
    { Value: byDefault,        Label: 'By Default' },
    { Value: bySrcJouleTool,   Label: 'Via Joule' },
    { Value: bySrcPageLoad,    Label: 'Via Page Load' },
    { Value: avgConfidence,    Label: 'Avg Confidence' }
  ],
  UI.SelectionFields: [ tutorialSlug, surface ],
  UI.PresentationVariant: {
    SortOrder: [ { Property: total, Descending: true } ],
    Visualizations: [ '@UI.LineItem' ]
  }
);

// PR 6 — Pilot enablement: read-only Fiori Elements list view for support.
// Edit-on-behalf is out of scope for v1 (the entity is @readonly on AdminService).
// Spec: §7.7
annotate AdminService.LearningPreferences with @cds.search: { user.email, user.displayName };

annotate AdminService.LearningPreferences with @UI: {
  HeaderInfo: {
    TypeName: 'Learning preference', TypeNamePlural: 'Learning preferences',
    Title: { Value: user.email },
    Description: { Value: user.displayName }
  },
  SelectionFields: [ deployment, role, cloud ],
  LineItem: [
    { Value: user.email },
    { Value: user.displayName },
    { Value: deployment },
    { Value: role },
    { Value: cloud },
    { Value: modifiedAt }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Preferences' }
  ],
  FieldGroup#General: { Data: [
    { Value: user.email }, { Value: deployment }, { Value: role }, { Value: cloud }
  ]}
};

// =====================================================================
// Developer Advocates (Phase 6 of advocates impl)
// =====================================================================

annotate AdminService.Advocates with {
  slug         @Common.Label: 'Slug'        @UI.HiddenFilter;
  firstName    @Common.Label: 'First name';
  lastName     @Common.Label: 'Last name';
  title        @Common.Label: 'Title';
  pronouns     @Common.Label: 'Pronouns';
  location     @Common.Label: 'Location';
  region       @Common.Label: 'Region'
               @Common.ValueListWithFixedValues
               @Common.ValueList: {
                 CollectionPath: 'AdvocateRegions',
                 Parameters: [
                   { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: region, ValueListProperty: 'code' },
                   { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' }
                 ]
               };
  bio          @Common.Label: 'Bio'         @UI.MultiLineText;
  isActive     @Common.Label: 'Active';
  sortOverride @Common.Label: 'Sort override';
  joinedDate   @Common.Label: 'Joined';
  hasPhoto     @Common.Label: 'Has photo'   @UI.HiddenFilter @Core.Computed;
  photoUpdatedAt @Common.Label: 'Photo updated' @UI.HiddenFilter @Core.Computed;
  photoUrl     @Common.Label: 'Photo URL'   @UI.HiddenFilter @Core.Computed;
};

annotate AdminService.Advocates with @(
  // Object Page header avatar restored in v2 (issue #415). Wires the OP
  // HeaderInfo.ImageUrl to the persisted photoUrl column maintained by
  // the after-handlers in srv/handlers/advocate-handlers.js. PR #404
  // tried this with a virtual element and hit OData v4 'invalid segment'
  // errors on $expand=DraftAdministrativeData — Advocates is draft-enabled,
  // so the persisted-column form is the only shape known to survive
  // drill-down. The trade-off (two sources of truth: hasPhoto + photoUrl)
  // is contained by the handlers keeping them in sync on every
  // photo-write / photo-delete / slug-rename path.
  UI.HeaderInfo: {
    TypeName: 'Advocate',
    TypeNamePlural: 'Advocates',
    Title: { Value: lastName },
    Description: { Value: title },
    ImageUrl: photoUrl
  },
  UI.SelectionFields: [ region, isActive, lastName ],
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: lastName,  Label: 'Last name' },
    { $Type: 'UI.DataField', Value: firstName, Label: 'First name' },
    { $Type: 'UI.DataField', Value: title,     Label: 'Title' },
    { $Type: 'UI.DataField', Value: region,    Label: 'Region' },
    { $Type: 'UI.DataField', Value: isActive,  Label: 'Active' }
  ],
  UI.PresentationVariant: {
    SortOrder: [
      { Property: lastName,  Descending: false },
      { Property: firstName, Descending: false }
    ],
    Visualizations: [ '@UI.LineItem' ]
  },
  UI.FieldGroup #Identity: {
    Data: [
      { Value: firstName },
      { Value: lastName },
      { Value: pronouns },
      { Value: title },
      { Value: location },
      { Value: region },
      { Value: joinedDate }
    ]
  },
  UI.FieldGroup #Bio: {
    Data: [ { $Type: 'UI.DataField', Value: bio, ![@UI.MultiLineText]: true } ]
  },
  UI.FieldGroup #Visibility: {
    Data: [
      { Value: isActive },
      { Value: sortOverride },
      { Value: slug }
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Identity',   Label: 'Identity',     Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', ID: 'Bio',        Label: 'Bio',          Target: '@UI.FieldGroup#Bio' },
    { $Type: 'UI.ReferenceFacet', ID: 'Visibility', Label: 'Visibility',   Target: '@UI.FieldGroup#Visibility' },
    // Photo facet intentionally omitted in v1: the Fiori UploadSet on a
    // draft-enabled `Composition of one` whose key IS the parent
    // association doesn't persist uploads cleanly (the photo bytes go
    // through Fiori's media-stream PUT but never reach our before-CREATE
    // handler — confirmed via empty AdvocatePhotos table after a save).
    // The avatar in @UI.HeaderInfo.ImageUrl above still works because
    // it routes through the public /api/advocates/:slug/photo endpoint.
    // For v2: a custom controller-extension that intercepts the upload
    // and POSTs to a new Advocates.uploadPhoto bound action.
    { $Type: 'UI.ReferenceFacet', ID: 'Topics',     Label: 'Topics',       Target: 'topics/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'Links',      Label: 'Social links', Target: 'links/@UI.LineItem' }
  ]
);

// AdvocatePhotos — Fiori Elements renders an UploadSet for @Core.MediaType
// columns. The Photo facet on the Advocate Object Page targets this
// FieldGroup, which surfaces the photo256 column as an upload control.
// photo64 is server-derived (sharp resamples on every upload); we don't
// expose it in the UI to avoid confusion.
annotate AdminService.AdvocatePhotos with {
  photo256       @Common.Label: 'Photo'      @Core.ContentDisposition: { Filename: 'advocate-photo.webp' };
  photoMimeType  @Common.Label: 'MIME type'  @UI.HiddenFilter @Core.Computed;
  sizeBytes      @Common.Label: 'Size (bytes)' @UI.HiddenFilter @Core.Computed;
  sha256         @Common.Label: 'SHA-256'    @UI.HiddenFilter @Core.Computed;
  uploadedAt     @Common.Label: 'Uploaded'   @UI.HiddenFilter @Core.Computed;
};

annotate AdminService.AdvocatePhotos with @(
  UI.FieldGroup #Photo: {
    Data: [
      { $Type: 'UI.DataField', Value: photo256, Label: 'Photo' }
    ]
  }
);

// AdvocateTopics — inline table with Tag value-help.
// The visible cell shows Tag.label (via @Common.Text on the association,
// resolved through tag_ID -> Tags). The value-help dialog ranks 'label'
// first so admins find topics by their human label, not by GUID.
annotate AdminService.AdvocateTopics with {
  tag @Common.Label: 'Topic'
      @Common.Text: tag.label
      @Common.TextArrangement: #TextOnly
      @Common.ValueList: {
        CollectionPath: 'Tags',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: tag_ID, ValueListProperty: 'ID' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'label' },
          { $Type: 'Common.ValueListParameterDisplayOnly',                            ValueListProperty: 'name' }
        ]
      };
};

annotate AdminService.AdvocateTopics with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: tag.label, Label: 'Topic' }
  ]
};

// AdvocateLinks — inline table for the social-links facet.
annotate AdminService.AdvocateLinks with {
  kind      @Common.Label: 'Kind';
  url       @Common.Label: 'URL';
  label     @Common.Label: 'Label override';
  sortOrder @Common.Label: 'Sort';
};

annotate AdminService.AdvocateLinks with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: kind,      Label: 'Kind' },
    { $Type: 'UI.DataField', Value: url,       Label: 'URL' },
    { $Type: 'UI.DataField', Value: label,     Label: 'Label' },
    { $Type: 'UI.DataField', Value: sortOrder, Label: 'Sort' }
  ]
};

// =============================================================================
// KnowledgeGraphService — Concepts admin curation (#381 PR 6)
// =============================================================================
//
// Concepts is exposed by KnowledgeGraphService at /graph/. The Fiori Elements
// admin app at /admin-ui/#concepts-display talks to /graph/ directly (not /admin/),
// but its @UI annotations live in this file so all admin-side @UI metadata stays
// co-located.
//
// The dropped Criticality: clause on `status` is a deliberate simplification:
// adding it would require a virtual or calculated element on the projection
// (statusCriticality returning 3=ACTIVE, 5=MERGED/Veto-friendly, 1=VETOED).
// The plain status string is good enough for v1 — admins can read ACTIVE /
// MERGED / VETOED at a glance. Track in PR 6.x follow-up if a Criticality
// signal is desired.
using KnowledgeGraphService from '../srv/knowledge-graph-service';

annotate KnowledgeGraphService.Concepts with {
  slug            @Common.Label: 'Slug'           @Common.FieldControl: #ReadOnly;
  name            @Common.Label: 'Name';
  description     @Common.Label: 'Description'    @Common.MultiLineText;
  status          @Common.Label: 'Status'         @Common.FieldControl: #ReadOnly;
  extractionCount @Common.Label: 'Extractions'    @Common.FieldControl: #ReadOnly;
  firstSeenAt     @Common.Label: 'First Seen'     @Common.FieldControl: #ReadOnly;
  lastSeenAt      @Common.Label: 'Last Seen'      @Common.FieldControl: #ReadOnly;
};

annotate KnowledgeGraphService.Concepts with @(
  UI.HeaderInfo: {
    TypeName       : 'Concept',
    TypeNamePlural : 'Concepts',
    Title          : { Value: name },
    Description    : { Value: slug }
  },

  UI.SelectionFields: [ status, slug ],

  UI.LineItem: [
    { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
    { $Type: 'UI.DataField', Value: name,            Label: 'Name' },
    { $Type: 'UI.DataField', Value: status,          Label: 'Status' },
    { $Type: 'UI.DataField', Value: extractionCount, Label: 'Extractions' },
    { $Type: 'UI.DataField', Value: lastSeenAt,      Label: 'Last Seen' },
    // ID exposed last so admins can copy the canonical UUID for paste-into-mergeConcepts
    // workflow without dominating the table layout.
    { $Type: 'UI.DataField', Value: ID,              Label: 'ID' }
  ],

  UI.FieldGroup #General: {
    Data: [
      { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
      { $Type: 'UI.DataField', Value: name,            Label: 'Name' },
      { $Type: 'UI.DataField', Value: description,     Label: 'Description' },
      { $Type: 'UI.DataField', Value: status,          Label: 'Status' },
      { $Type: 'UI.DataField', Value: extractionCount, Label: 'Extractions' },
      { $Type: 'UI.DataField', Value: firstSeenAt,     Label: 'First Seen' },
      { $Type: 'UI.DataField', Value: lastSeenAt,      Label: 'Last Seen' }
    ]
  },

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',         Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Tutorials',       Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Outgoing edges',  Target: 'outgoingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges',  Target: 'incomingEdges/@UI.LineItem' }
  ],

  // Inline-edit only on `name` + `description`. The other fields are gated by
  // @Common.FieldControl: #ReadOnly above. Status flips happen through the
  // vetoConcept / mergeConcepts actions, not direct PATCH.
  Capabilities.UpdateRestrictions: { Updatable: true },
  Capabilities.DeleteRestrictions: { Deletable: false },
  Capabilities.InsertRestrictions: { Insertable: false }
);

// --- TutorialConceptLinks — read-only inline table on the OP "Tutorials" facet
annotate KnowledgeGraphService.TutorialConceptLinks with {
  predicate   @Common.Label: 'Predicate';
  confidence  @Common.Label: 'Confidence';
  extractedAt @Common.Label: 'Extracted At';
};

annotate KnowledgeGraphService.TutorialConceptLinks with @UI: {
  LineItem: [
    // tutorial_ID (UUID) shown instead of tutorial.slug because Tutorials is not
    // projected into KnowledgeGraphService — the `tutorial` association has no
    // NavigationProperty in the EDMX so dot-paths fail at OP render time.
    // TODO(PR 7+): project Tutorials into KG service for slug+title display.
    { $Type: 'UI.DataField', Value: tutorial_ID,      Label: 'Tutorial ID' },
    { $Type: 'UI.DataField', Value: predicate,        Label: 'Predicate' },
    { $Type: 'UI.DataField', Value: confidence,       Label: 'Confidence' },
    { $Type: 'UI.DataField', Value: extractedAt,      Label: 'Extracted At' }
  ]
};

// --- ConceptEdges — read-only inline table on the OP "Edges" facets
annotate KnowledgeGraphService.ConceptEdges with {
  predicate  @Common.Label: 'Predicate';
  confidence @Common.Label: 'Confidence';
  status     @Common.Label: 'Status';
};

annotate KnowledgeGraphService.ConceptEdges with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: source.slug, Label: 'Source' },
    { $Type: 'UI.DataField', Value: target.slug, Label: 'Target' },
    { $Type: 'UI.DataField', Value: predicate,   Label: 'Predicate' },
    { $Type: 'UI.DataField', Value: confidence,  Label: 'Confidence' },
    { $Type: 'UI.DataField', Value: status,      Label: 'Status' }
  ]
};
