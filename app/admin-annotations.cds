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
  eventType @Common.Label: 'Event Type'
            @Common.ValueListWithFixedValues
            // Issue #715 — Value-list backing for the DDLB. Code list served by
            // srv/admin-service.js → 'EventTypes'. With ValueListWithFixedValues
            // + a DisplayOnly label parameter, Fiori Elements V4 renders the
            // label ("Devtoberfest") in both the dropdown and the read-only
            // list-report / OP cells, so no separate @Common.Text needed.
            // Mirrors AdvocateRegions (app/admin-annotations.cds:2182).
            @Common.ValueList: {
              CollectionPath: 'EventTypes',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: eventType, ValueListProperty: 'code'  },
                { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
              ]
            };
};

annotate AdminService.Events with @UI: {
  HeaderInfo: {
    TypeName: 'Event', TypeNamePlural: 'Events',
    Title: { Value: name },
    Description: { Value: timeZone }
  },
  SelectionFields: [ name, eventType, startDate, endDate ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: name },
    { Value: eventType },
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
    { Value: eventType },
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
  ]},
  Identification: [
    {
      $Type            : 'UI.DataFieldForAction',
      Label            : 'Rebuild this tutorial',
      Action           : 'AdminService.rebuildContent',
      ![@UI.Importance]: #High,
    }
  ]
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

// --- Tutorials OP expansion (PR-1 of spec 2026-06-24-tutorials-admin-tile-expansion-design) ---
// Tier-1: pure annotations of data that's already on AdminService.Tutorials
// one association away but wasn't surfaced. Adds Contributors facet, Steps
// facet, and brings the TutorialMeta review fields onto the Lifecycle tab.
// The Repository link rides along inside the Lifecycle FieldGroup since
// meta.repository.name is already navigable.

annotate AdminService.TutorialContributors with {
  name  @Common.Label: 'Name';
  email @Common.Label: 'Email';
  role  @Common.Label: 'Role';
};

annotate AdminService.TutorialContributors with @UI.LineItem: [
  { Value: name },
  { Value: email },
  { Value: role }
];

annotate AdminService.Steps with {
  stepOrder @Common.Label: 'Step #';
  title     @Common.Label: 'Title';
  status    @Common.Label: 'Status';
};

annotate AdminService.Steps with @UI: {
  LineItem: [
    { Value: stepOrder, @UI.Importance: #High },
    { Value: title },
    { Value: status }
  ],
  PresentationVariant: {
    SortOrder: [ { Property: stepOrder, Descending: false } ]
  }
};

// TutorialMeta review-tracking fields exposed on the Lifecycle tab.
// owner is already annotated above; add the review trail next to it.
annotate AdminService.TutorialMeta with {
  reviewedDate         @Common.Label: 'Last Reviewed';
  monitoredStatus      @Common.Label: 'Monitored Status';
  notificationNumber   @Common.Label: 'Notifications Sent';
  lastNotificationDate @Common.Label: 'Last Notification';
  repository           @Common.Label: 'Source Repository'
                       @Common.Text: repository.name
                       @Common.TextArrangement: #TextOnly;
};

// Replace the Tutorials Facets + Lifecycle FieldGroup to add Contributors,
// Steps, and the expanded Lifecycle. The earlier annotate-with block above
// declared a narrower Lifecycle FieldGroup; this annotate-with overrides
// just the bits we want to change while preserving the General / Categories
// / Feedback facets verbatim.
annotate AdminService.Tutorials with @UI: {
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',  Label: 'General',  Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Steps', ID: 'StepsFacet', Target: 'steps/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Contributors', ID: 'ContributorsFacet', Target: 'contributors/@UI.LineItem' },
    { $Type: 'UI.CollectionFacet', ID: 'Feedback', Label: 'Feedback', Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackSummary',
        Target: 'feedbackSummary/@UI.FieldGroup#FeedbackSummary',
        Label:  'Summary' },
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackItems',
        Target: 'feedbackItems/@UI.LineItem#TutorialFeedback',
        Label:  'Recent Submissions' }
    ]}
  ],
  FieldGroup#Lifecycle: { Data: [
    { Value: status },
    { Value: deletionReason },
    { Value: redirectTo_ID, Label: 'Redirect To' },
    { Value: meta.reviewedDate, Label: 'Last Reviewed' },
    { Value: meta.monitoredStatus, Label: 'Monitored Status' },
    { Value: meta.notificationNumber, Label: 'Notifications Sent' },
    { Value: meta.lastNotificationDate, Label: 'Last Notification' },
    { Value: meta.repository.name, Label: 'Source Repository' }
  ]}
};

// AdminService.Tutorials.author — searchable Users value help.
//
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
//
// With ~1k+ Users rows, a fixed-values dropdown is impractical.
// SearchSupported: true tells FE V4 to issue ?$search=… queries
// instead of loading the full collection. @cds.search on the Users
// projection (srv/admin-service.cds) makes the CAP runtime translate
// $search into HANA CONTAINS across displayName/firstName/lastName/
// email/sapId.
//
// Three display columns (displayName, email, sapId) so admins can
// type "tom" → see "Thomas Jung / tom.jung@sap.com / I809764" → pick.
//
// FK-propagation caveat: the @Common.Text and @Common.ValueList on
// `author` should propagate to the generated `author_ID` FK via
// cds-compiler's Feb 2025 "Annotating Managed Associations" feature
// — verified for the analogous AdvocateTopics/tag case in PR #607
// (see app/admin-annotations.cds history around the AdvocateTopics
// block). The admin annotations regression test pins the
// propagation in $metadata; if it ever regresses (e.g., compiler
// change) add a sibling annotate { author_ID @... } block as workaround.
annotate AdminService.Tutorials with {
  author @Common.Label: 'Author'
         @Common.Text: author.displayName
         @Common.TextArrangement: #TextOnly
         @Common.ValueList: {
           CollectionPath: 'Users',
           SearchSupported: true,
           Parameters: [
             { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: author_ID, ValueListProperty: 'ID' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'displayName' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'email' },
             { $Type: 'Common.ValueListParameterDisplayOnly',                               ValueListProperty: 'sapId' }
           ]
         };
};

// --- PR-4 of spec 2026-06-24-tutorials-admin-tile-expansion-design ---
// Annotations that wire PR-3's data (new view + projections + inverse
// associations on Tutorials) into per-tutorial facets on the Tutorials
// Object Page. Pure annotations; no schema or code changes.

// TutorialCompletionStats — one row per tutorial slug, joined via the
// `completionStats` association added in PR-3.
annotate AdminService.TutorialCompletionStats with {
  uniqueLearners  @Common.Label: 'Unique Learners';
  completions     @Common.Label: 'Total Completions';
  avgTimeMs       @Common.Label: 'Avg Time (ms)';
  firstCompletion @Common.Label: 'First Completion';
  lastCompletion  @Common.Label: 'Last Completion';
};

annotate AdminService.TutorialCompletionStats with @UI: {
  // Inline FieldGroup so the Tutorials OP can ReferenceFacet into it.
  FieldGroup#Stats: { Data: [
    { Value: uniqueLearners },
    { Value: completions },
    { Value: avgTimeMs },
    { Value: firstCompletion },
    { Value: lastCompletion }
  ]}
};

// ValidateAnswerSpecs — per-step, per-question validation rules
// (free-text grader specs). Joined via `validationSpecs` association.
annotate AdminService.ValidateAnswerSpecs with {
  stepNumber    @Common.Label: 'Step';
  questionId    @Common.Label: 'Question ID';
  questionText  @Common.Label: 'Question';
  correctAnswer @Common.Label: 'Correct Answer';
  ruleType      @Common.Label: 'Rule Type';
  aiGrading     @Common.Label: 'AI Grading';
};

annotate AdminService.ValidateAnswerSpecs with @UI: {
  LineItem: [
    { Value: stepNumber, @UI.Importance: #High },
    { Value: questionId },
    { Value: questionText },
    { Value: ruleType },
    { Value: aiGrading }
  ],
  PresentationVariant: {
    SortOrder: [
      { Property: stepNumber, Descending: false },
      { Property: questionId, Descending: false }
    ]
  }
};

// CodeCheckSpecs — per-step code-check specs (goal + reference solution).
// Joined via `codeCheckSpecs` association.
annotate AdminService.CodeCheckSpecs with {
  stepNumber   @Common.Label: 'Step';
  goal         @Common.Label: 'Goal' @UI.MultiLineText;
  language     @Common.Label: 'Language';
  hasReference @Common.Label: 'Has Reference Solution';
};

annotate AdminService.CodeCheckSpecs with @UI: {
  LineItem: [
    { Value: stepNumber, @UI.Importance: #High },
    { Value: language },
    { Value: hasReference },
    { Value: goal }
  ],
  PresentationVariant: {
    SortOrder: [ { Property: stepNumber, Descending: false } ]
  }
};

// AuthorAiRequests — per-tutorial AI-author telemetry (OS variant
// generation today; future flows extend). Joined via `aiRequests`
// association (PR-3 added the tutorial FK).
annotate AdminService.AuthorAiRequests with {
  feature        @Common.Label: 'Feature';
  sourceOS       @Common.Label: 'Source OS';
  targetOSes     @Common.Label: 'Target OSes';
  model          @Common.Label: 'Model';
  tokensUsed     @Common.Label: 'Tokens';
  durationMs     @Common.Label: 'Duration (ms)';
  errorCode      @Common.Label: 'Error';
  authorId       @Common.Label: 'XSUAA Author ID';
  sourceLength   @Common.Label: 'Source Length';
  variantsLength @Common.Label: 'Variants Length';
  variants       @Common.Label: 'Variants (JSON)' @UI.MultiLineText;
};

annotate AdminService.AuthorAiRequests with @UI: {
  LineItem: [
    { Value: createdAt },
    { Value: feature },
    { Value: sourceOS },
    { Value: targetOSes },
    { Value: model },
    { Value: tokensUsed },
    { Value: durationMs },
    { Value: errorCode }
  ],
  PresentationVariant: {
    SortOrder: [ { Property: createdAt, Descending: true } ]
  }
};

// Append the four new facets to the Tutorials Object Page. This third
// `annotate ... with @UI: { Facets: [...] }` block fully replaces the
// prior list (CDS doesn't merge collection-valued annotations — the
// 'Duplicate assignment' warning at cds build is intentional). Each
// preceding facet (General, Lifecycle, Categories, Steps, Contributors,
// SourceMarkdownFacet from PR-2, Feedback) is preserved verbatim, with
// the four new ones tacked on between Contributors and Feedback so
// the Source Markdown section from PR-2 still sits next to Feedback.
annotate AdminService.Tutorials with @UI: {
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',  Label: 'General',  Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Steps', ID: 'StepsFacet', Target: 'steps/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Contributors', ID: 'ContributorsFacet', Target: 'contributors/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Completion Stats', ID: 'CompletionStatsFacet',
      Target: 'completionStats/@UI.FieldGroup#Stats' },
    { $Type: 'UI.ReferenceFacet', Label: 'Validation Questions', ID: 'ValidationSpecsFacet',
      Target: 'validationSpecs/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Code-Check Specs', ID: 'CodeCheckSpecsFacet',
      Target: 'codeCheckSpecs/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'AI-Author Requests', ID: 'AiRequestsFacet',
      Target: 'aiRequests/@UI.LineItem' },
    { $Type: 'UI.CollectionFacet', ID: 'Feedback', Label: 'Feedback', Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackSummary',
        Target: 'feedbackSummary/@UI.FieldGroup#FeedbackSummary',
        Label:  'Summary' },
      { $Type: 'UI.ReferenceFacet', ID: 'FeedbackItems',
        Target: 'feedbackItems/@UI.LineItem#TutorialFeedback',
        Label:  'Recent Submissions' }
    ]}
  ]
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

// --- TaskRecords (per-user progress audit; SUPERSEDED rows are historical
// attempts kept for audit, hidden from the default list view per issue #600).
// `attemptNumber` surfaces alongside status/progress so audit reviewers can
// see which attempt a row belongs to. The default SelectionPresentationVariant
// excludes status=SUPERSEDED — admins flip the status filter to see history.
annotate AdminService.TaskRecords with {
  taskType      @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status        @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress      @Common.Label: 'Progress';
  attemptNumber @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot @Common.Label: 'Title';
};

annotate AdminService.TaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Task Record', TypeNamePlural: 'Task Records',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ taskType, status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: taskType },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    // Default-hide SUPERSEDED rows so admins debugging current state aren't
    // visually cluttered with historical audit attempts. Admins can flip the
    // status filter to view SUPERSEDED rows when reviewing reset history.
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E,                 // EXCLUDE
            Option: #EQ,
            Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// Issue #644 — per-taskType drill-down projections (six total: TUTORIAL,
// MISSION, GROUP, STEP, CHECKPOINT, PUZZLE). Each reuses the same column
// labels and SUPERSEDED-hiding default selection variant as the parent
// TaskRecords entity, plus a single typed association column where one
// exists. Read-only across the board (matches TaskRecords parent).
annotate AdminService.TutorialTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
  tutorial       @Common.Label: 'Tutorial';
};
annotate AdminService.TutorialTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Tutorial Completion', TypeNamePlural: 'Tutorial Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.MissionTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
  mission        @Common.Label: 'Mission';
};
annotate AdminService.MissionTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Mission Completion', TypeNamePlural: 'Mission Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.GroupTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
  group          @Common.Label: 'Group';
};
annotate AdminService.GroupTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Group Completion', TypeNamePlural: 'Group Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.StepTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
  step           @Common.Label: 'Step';
};
annotate AdminService.StepTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Step Completion', TypeNamePlural: 'Step Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.CheckpointTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
};
annotate AdminService.CheckpointTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Checkpoint Completion', TypeNamePlural: 'Checkpoint Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.PuzzleTaskRecords with {
  taskType       @Common.Label: 'Task Type'  @Common.ValueListWithFixedValues;
  status         @Common.Label: 'Status'     @Common.ValueListWithFixedValues;
  progress       @Common.Label: 'Progress';
  attemptNumber  @Common.Label: 'Attempt';
  completionDate @Common.Label: 'Completed';
  titleSnapshot  @Common.Label: 'Title';
  puzzle         @Common.Label: 'Puzzle';
};
annotate AdminService.PuzzleTaskRecords with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Puzzle Completion', TypeNamePlural: 'Puzzle Completions',
      Title: { Value: titleSnapshot },
      Description: { Value: status }
    },
    SelectionFields: [ status, completionDate, attemptNumber ],
    LineItem: [
      { Value: completionDate },
      { Value: titleSnapshot },
      { Value: status },
      { Value: progress },
      { $Type: 'UI.DataField', Value: attemptNumber, Label: 'Attempt' }
    ],
    SelectionPresentationVariant #default: {
      $Type: 'UI.SelectionPresentationVariantType',
      Text: 'Active (excludes SUPERSEDED)',
      SelectionVariant: {
        $Type: 'UI.SelectionVariantType',
        SelectOptions: [{
          $Type: 'UI.SelectOptionType',
          PropertyName: status,
          Ranges: [{
            $Type: 'UI.SelectionRangeType',
            Sign: #E, Option: #EQ, Low: 'SUPERSEDED'
          }]
        }]
      },
      PresentationVariant: { Visualizations: ['@UI.LineItem'] }
    },
    Sort: [{ Property: completionDate, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// ChangeView: plugin provides LineItem, PresentationVariant, FieldGroups, Hierarchy, Search.
// ReadRestrictions override is applied at runtime in srv/admin-service.js.
// We add SelectionFields for the standalone ListReport filter bar.
// Must target sap.changelog.ChangeView (the base) since AdminService.ChangeView is injected at runtime.
//
// Filter UX fixes (2026-06-22, after Tom's admin walkthrough):
//   1. Explicit @Common.Label on each filterable column so FE V4 doesn't fall
//      back to whatever the @title resolves to (was rendering the createdBy
//      filter as "Change Type" — a duplicate-label clash with modificationLabel).
//   2. Value-help dropdown on modificationLabel via the existing
//      sap.changelog.ChangeView@UI.Identification + a code list of the 3
//      enum codes (Create/Update/Delete).
//   3. createdAt explicitly in the filter bar (date range — admins asked
//      for date filtering during walkthrough).
using { sap.changelog.ChangeView } from '@cap-js/change-tracking';
annotate ChangeView with {
  entityLabel       @Common.Label: 'Object Type';
  modificationLabel @Common.Label: 'Change Type'
                    @Common.ValueListWithFixedValues
                    @Common.ValueList: {
                      CollectionPath: 'ChangeTypes',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: modificationLabel, ValueListProperty: 'label' },
                        { $Type: 'Common.ValueListParameterDisplayOnly',                                       ValueListProperty: 'code'  }
                      ]
                    };
  createdBy         @Common.Label: 'Changed By';
  createdAt         @Common.Label: 'Changed At';
};

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

// --- PrivacyProtectionActions (GDPR / DSR audit trail, read-only) ---
// Surfaces the audit data behind /admin-ui/#privacy-audit-display so admins
// can browse historical SEARCH / DOWNLOAD / ANONYMIZE actions. Wizard-style
// privacy workflow stays at /admin-ui/#privacy-display; this tile is the
// historical view of all completed actions across the lifetime of the
// system (including migrated IMS PROD audit rows after PR #554's migration
// step 16 runs).
annotate AdminService.PrivacyProtectionActions with {
  userUuid          @Common.Label: 'User UUID (PET / SAP ID)';
  actionType        @Common.Label: 'Action'
                    @Common.ValueListWithFixedValues
                    @Common.ValueList: {
                      CollectionPath: 'PrivacyActionTypes',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: actionType, ValueListProperty: 'code'  },
                        { $Type: 'Common.ValueListParameterDisplayOnly',                                ValueListProperty: 'label' }
                      ]
                    };
  status            @Common.Label: 'Status';
  requestedAt       @Common.Label: 'Requested At';
  completedAt       @Common.Label: 'Completed At';
  dsrRequestNumber  @Common.Label: 'DSR Request #';
  createdBy         @Common.Label: 'Initiated By';
};

annotate AdminService.PrivacyProtectionActions with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Privacy Action', TypeNamePlural: 'Privacy Audit',
      Title: { Value: actionType },
      Description: { Value: userUuid }
    },
    SelectionFields: [ actionType, status, userUuid, dsrRequestNumber, createdBy, requestedAt ],
    LineItem: [
      { Value: requestedAt },
      { Value: actionType },
      { Value: userUuid },
      { Value: dsrRequestNumber },
      { Value: createdBy },
      { Value: status },
      { Value: completedAt }
    ],
    PresentationVariant: {
      SortOrder: [{ Property: requestedAt, Descending: true }]
    }
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

  // AdminService.Advocates.user — searchable Users value help.
  //
  // Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §2
  //
  // Same SearchSupported pattern as Tutorials.author from PR #618. The
  // @cds.search on the Users projection (srv/admin-service.cds) translates
  // $search into HANA CONTAINS across displayName / firstName / lastName /
  // email / sapId — admin types "thomas.jung@" and gets the row.
  //
  // Three display columns (displayName, email, sapId) match the Author
  // value-help precedent (app/admin-annotations.cds:725-739).
  user @Common.Label: 'Linked User'
       @Common.Text: user.displayName
       @Common.TextArrangement: #TextOnly
       @Common.ValueList: {
         CollectionPath: 'Users',
         SearchSupported: true,
         Parameters: [
           { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: user_ID, ValueListProperty: 'ID' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'displayName' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'email' },
           { $Type: 'Common.ValueListParameterDisplayOnly',                             ValueListProperty: 'sapId' }
         ]
       };

  // Spec: docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md §4.4.
  // Inverse-Association nav properties on the Advocates projection. Hide
  // Create/Delete/edit affordances so admins don't accidentally try to
  // mutate tutorials from the Advocate OP (these are read-through views,
  // not Compositions). FE V4 honors @Capabilities.* on navigation aliases.
  authoredTutorials    @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false };
  contributedTutorials @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false };
  // #777 followup — ownedTutorials is a read-only view; prevent accidental
  // create/update/delete affordances in the Fiori Object Page facet.
  ownedTutorials       @Capabilities.InsertRestrictions: { Insertable: false }
                       @Capabilities.UpdateRestrictions: { Updatable:  false }
                       @Capabilities.DeleteRestrictions: { Deletable:  false };
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
  // Spec: 2026-06-25-advocate-email-edit-design.md §4.2.
  // Linked-User identity field group — picker + editable email mirror.
  // emailEdit is a virtual element hydrated on-READ and propagated to
  // Users.email on-UPDATE / SAVE-on-drafts; see srv/handlers/advocate-email-handlers.js.
  UI.FieldGroup #IdentityLink: {
    Data: [
      { $Type: 'UI.DataField', Value: user_ID,   Label: 'Linked User' },
      { $Type: 'UI.DataField', Value: emailEdit, Label: 'Email' }
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Identity',   Label: 'Identity',     Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', ID: 'IdentityLink', Label: 'Linked User', Target: '@UI.FieldGroup#IdentityLink' },
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
    { $Type: 'UI.ReferenceFacet', ID: 'Links',      Label: 'Social links', Target: 'links/@UI.LineItem' },
    // #777 followup (2026-06-30) — replaced the prior Authored/Contributed
    // dual facet with a single Owned facet reading through MyTutorialsByUserId
    // (the canonical 4-source UNION bridged by Users.ID).
    // Sources 1 (author FK) + 2 (contributor FK) + 3 (TutorialMeta.ownerEmail)
    // + 4 (legacy free-text owner) all surface here; the per-row `bestPriority`
    // column shows which source matched. Count matches /api/advocates (~77 vs ~7).
    { $Type: 'UI.ReferenceFacet', ID: 'OwnedTutorials', Label: 'Owned Tutorials', Target: 'ownedTutorials/@UI.LineItem' }
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

// #777 followup (2026-06-30) — minimal LineItem for the Advocate Object Page
// ownedTutorials facet. Read-only display; shown inside the OwnedTutorials
// reference facet (Target: 'ownedTutorials/@UI.LineItem').
// bestPriority encodes the source: 1=author FK, 2=contributor, 3=ownerEmail, 4=legacy text.
annotate AdminService.MyTutorials with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: slug,            Label: 'Slug' },
    { $Type: 'UI.DataField', Value: title,           Label: 'Title' },
    { $Type: 'UI.DataField', Value: bestPriority,    Label: 'Source' },
    { $Type: 'UI.DataField', Value: monitoredStatus, Label: 'Status' }
  ],
  UI.PresentationVariant: {
    SortOrder: [
      { Property: bestPriority, Descending: false },
      { Property: title,        Descending: false }
    ]
  }
);

annotate AdminService.MyTutorials with {
  bestPriority    @Common.Label: 'Source';
  slug            @Common.Label: 'Slug';
  title           @Common.Label: 'Title';
  monitoredStatus @Common.Label: 'Status';
};

// AdvocateTopics — inline table with Tag value-help.
//
// LineItem binds to the FK `tag_ID`, NOT the navigation path `tag.label`.
// Why: FE V4 renders an editable cell against a real local property, then
// resolves the displayed text via `@Common.Text` and attaches value help
// from `@Common.ValueList` — both inherited from the `tag` association
// by the cds-compiler's "annotate managed association → propagate to FK"
// behavior (Feb 2025 release, automatic for expression-valued annotations
// referencing target properties — verified in the emitted EDMX).
//
// Three-bug history before this shape:
//
//   #573 (initial) — bound LineItem to `tag.label`. FE V4 read the
//   navigation path without an $expand and rendered blank/GUID; editing
//   surfaced an empty text box because the path is not writable from
//   the cell directly.
//
//   #586 (annotation-side patch) — added a second `annotate
//   AdminService.AdvocateTopics with { tag_ID @... }` block thinking the
//   FK annotations weren't reaching the client. They actually were
//   (auto-propagated from the association), and the compiler silently
//   dropped the second block with `Element "tag_ID" has not been found`
//   because `tag_ID` isn't a declared element on the projection — it's
//   generated. The dead block produced a compiler warning every build.
//
//   #588 (display-side workaround) — kept the `tag.label` binding and
//   added the redundant FK annotate block in 1556, hoping FE V4 would
//   pick up the FK path on render. It did not, because the LineItem
//   was still pointing at the navigation path.
//
// This fix: bind LineItem to `tag_ID`, drop the dead `tag_ID @...` block,
// rely on the propagated association annotations alone.
//
// Value-help dialog: ranks `label` first so admins search by the human
// label, falls back to `name` (slug-equivalent) when label is missing.
annotate AdminService.AdvocateTopics with {
  // Spec: 2026-06-25-advocate-admin-ui-fixes-design.md §4.2.
  // Projection has no explicit field list, so the row's own ID is auto-
  // projected and FE V4 may surface it in the inline Topics table or the
  // column-personalization dialog. @UI.Hidden suppresses it cleanly.
  ID  @UI.Hidden;
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
    { $Type: 'UI.DataField', Value: tag_ID, Label: 'Topic' }
  ]
};

// AdvocateLinks — inline table for the social-links facet.
//
// `kind` renders as a fixed-values dropdown (mirrors the pattern used by
// Advocates.region → AdvocateRegions). The @assert.range enum on the
// underlying field (db/advocates.cds) is the runtime guard for writes
// that bypass the UI (CSV import, REST). The DDLB itself is driven by
// AdvocateLinkKinds, seeded in srv/admin-service.js.
annotate AdminService.AdvocateLinks with {
  kind      @Common.Label: 'Kind'
            @Common.ValueListWithFixedValues
            @Common.ValueList: {
              CollectionPath: 'AdvocateLinkKinds',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: kind, ValueListProperty: 'code' },
                { $Type: 'Common.ValueListParameterDisplayOnly',                          ValueListProperty: 'label' }
              ]
            };
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
  // Phase 3 (#446) — admin curation marker. Set by publishConcept,
  // cleared by unpublishConcept; never user-edited.
  publishedAt     @Common.Label: 'Published'      @Common.FieldControl: #ReadOnly;
  publishedBy     @Common.Label: 'Published By'   @Common.FieldControl: #ReadOnly;
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
    // Phase 3 (#446) — Published column. Criticality 3 (positive/green) when
    // set, 0 (neutral) when null. Not-published is the default state — not an
    // error — so it must render as neutral, not 1 (negative/red). OData V4
    // CriticalityType: 0=Neutral, 1=Negative, 2=Critical, 3=Positive. The
    // $edmJson form mirrors the conditional pattern used by Alerts.severityCrit
    // elsewhere in this file.
    {
      $Type: 'UI.DataField',
      Value: publishedAt,
      Label: 'Published',
      Criticality: { $edmJson: { $If: [ { $Ne: [ { $Path: 'publishedAt' }, null ] }, 3, 0 ] } }
    },
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
      { $Type: 'UI.DataField', Value: lastSeenAt,      Label: 'Last Seen' },
      { $Type: 'UI.DataField', Value: publishedAt,     Label: 'Published' },
      { $Type: 'UI.DataField', Value: publishedBy,     Label: 'Published By' }
    ]
  },

  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',         Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Tutorials',       Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Outgoing edges',  Target: 'outgoingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges',  Target: 'incomingEdges/@UI.LineItem' }
  ],

  // Phase 3 (#446) — Publish / Unpublish toolbar actions.
  // BOUND actions on Concepts so Fiori Elements V4 uses the selected-row
  // context — no parameter dialog. The Action reference matches the canonical
  // form used by AdminService.Tutorials/rebuildContent at line 609 above
  // (`<Service>.<actionName>`; FE V4 resolves the binding from context).
  UI.Identification: [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'KnowledgeGraphService.publishConcept',
      Label : 'Publish'
    },
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'KnowledgeGraphService.unpublishConcept',
      Label : 'Unpublish'
    }
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

// --- Devtoberfest (multi-row config + read-only registrations audit) ---
//
// Spec: docs/superpowers/specs/2026-06-24-devtoberfest-config-multi-row-draft-design.md
//
// DevtoberfestConfig is multi-row + @odata.draft.enabled (one row per
// Devtoberfest cycle). Exactly one row carries isActive=true at a
// time — public handlers (statusHandler, termsHandler, joule tool,
// join handler) select WHERE isActive=true. The CDS before-handler
// in srv/admin-service.js auto-deactivates the previously-active row
// on draft activation, preserving the invariant in one transaction.
//
// Admin tile is Fiori Elements List Report + Object Page at
// /admin-ui/#/devtoberfest. Replaces the previous custom UI5 tile
// (PR #598 / #599 / spec 2026-06-24).
annotate AdminService.DevtoberfestConfig with {
  isActive          @Common.Label: 'Active'
                    @title: 'Active'
                    @Core.Description: 'Exactly one config can be active at a time. Flipping this on will deactivate the previous active row.';
  currentEvent      @title: 'Current Devtoberfest Event'
                    @Common.Label: 'Event'
                    @Common.ValueList: {
                      Label: 'Event',
                      CollectionPath: 'Events',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: currentEvent_ID, ValueListProperty: 'ID' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'endDate' }
                      ]
                    }
                    @Common.Text: currentEvent.name @Common.TextArrangement: #TextOnly;
  termsText         @title: 'Content Rules (markdown)'
                    @Common.Label: 'Content Rules (markdown)'
                    @UI.MultiLineText;
  termsVersion      @title: 'Terms Version' @Common.Label: 'Terms Version';
  contentRulesUrl   @title: 'Content Rules URL' @Common.Label: 'Content Rules URL';
  faqUrl            @title: 'FAQ URL' @Common.Label: 'FAQ URL';
  gameboardUrl      @title: 'Gameboard URL' @Common.Label: 'Gameboard URL';
  activitiesUrl     @title: 'Activities URL' @Common.Label: 'Activities URL';
};

annotate AdminService.DevtoberfestConfig with @UI: {
  HeaderInfo: {
    TypeName: 'Devtoberfest Configuration', TypeNamePlural: 'Devtoberfest Configurations',
    Title: { Value: currentEvent.name },
    Description: { Value: termsVersion }
  },
  // Object Status for the active flag — green when active, neutral when not.
  // Surface this in both the LineItem and HeaderFacets so admins can see
  // at a glance which row is live.
  DataPoint#ActiveStatus: {
    Value: isActive,
    Title: 'Active',
    Criticality: isActive
  },
  SelectionFields: [ isActive, currentEvent_ID ],
  LineItem: [
    { Value: currentEvent.name,      Label: 'Event' },
    { Value: currentEvent.startDate, Label: 'Start' },
    { Value: currentEvent.endDate,   Label: 'End' },
    { Value: termsVersion,           Label: 'Terms Ver' },
    { $Type: 'UI.DataFieldForAnnotation',
      Target: '@UI.DataPoint#ActiveStatus',
      Label: 'Active' },
    { Value: modifiedAt,             Label: 'Last Modified' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General',  Label: 'Event & Status' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Terms',    Label: 'Content Rules / Terms' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SubPages', Label: 'Sub-pages (leave blank to hide)' }
  ],
  FieldGroup#General: { Data: [
    { Value: currentEvent_ID, Label: 'Event' },
    { Value: isActive },
    { Value: termsVersion }
  ]},
  FieldGroup#Terms: { Data: [
    { Value: termsText }
  ]},
  FieldGroup#SubPages: { Data: [
    { Value: contentRulesUrl },
    { Value: faqUrl },
    { Value: gameboardUrl },
    { Value: activitiesUrl }
  ]}
};

// EventRegistrations — read-only audit table.
// Annotated for FE inclusion as a list-style entity. The Devtoberfest
// admin tile currently doesn't surface registrations under each config
// row (since the registration→event link is on Events, not on
// DevtoberfestConfig directly); a future PR could expose them as a
// facet via $expand on `currentEvent/registrations`. For now this
// stays a standalone read-only entity — not bound into the tile UI.
annotate AdminService.EventRegistrations with {
  user             @title: 'User';
  event            @title: 'Event';
  joinedAt         @title: 'Joined At';
  termsVersion     @title: 'Terms Version';
  termsAcceptedAt  @title: 'Terms Accepted At';
};

annotate AdminService.EventRegistrations with @(
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// ── Users Object Page — Khoros columns + Clear action (issue #566) ──
// Read-only display of the 3 Khoros identity columns + a "Clear Khoros link"
// bound action button on the Users Object Page in the Accounts admin tile.
// khorosAvatarUrl is intentionally excluded from the FieldGroup (it's a URL,
// not meaningful as an OP column). khorosLinkedAt is a timestamp, shown for
// audit purposes.
annotate AdminService.Users with {
  khorosId        @Common.Label: 'Khoros ID'        @Common.FieldControl: #ReadOnly;
  khorosLogin     @Common.Label: 'Khoros Login'     @Common.FieldControl: #ReadOnly;
  khorosLinkedAt  @Common.Label: 'Khoros Linked At' @Common.FieldControl: #ReadOnly;
};

annotate AdminService.Users with @(UI: {
  FieldGroup #KhorosLink: {
    Data: [
      { Value: khorosId       },
      { Value: khorosLogin    },
      { Value: khorosLinkedAt },
    ]
  },
  Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      Label : 'SAP Community',
      Target: '@UI.FieldGroup#KhorosLink'
    }
  ],
  Identification: [
    {
      $Type : 'UI.DataFieldForAction',
      Action: 'AdminService.clearKhorosLink',
      Label : 'Clear Khoros link'
    }
  ]
});

// --- Alerts (#548) ---
// Site-wide banner / alert system. Virtual `severityCrit` is hydrated by the
// AdminService after-READ handler (srv/admin-service.js) and feeds the LineItem
// Criticality column so the severity cell renders in semantic color (3=green/info,
// 2=yellow/warn, 1=red/critical).
extend AdminService.Alerts with columns {
  virtual severityCrit : Integer
};

annotate AdminService.Alerts with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: active,    Label: 'On' },
    { $Type: 'UI.DataField', Value: severity,  Criticality: severityCrit },
    { $Type: 'UI.DataField', Value: audience },
    { $Type: 'UI.DataField', Value: title },
    { $Type: 'UI.DataField', Value: startsAt,  Label: 'Start (UTC)' },
    { $Type: 'UI.DataField', Value: endsAt,    Label: 'End (UTC)' },
  ],
  UI.SelectionFields: [ active, severity, audience ],
  UI.HeaderInfo: {
    TypeName: 'Alert', TypeNamePlural: 'Alerts',
    Title: { Value: title }, Description: { Value: severity },
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General',        Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', Label: 'Scheduling',     Target: '@UI.FieldGroup#Scheduling' },
    { $Type: 'UI.ReferenceFacet', Label: 'Call to action', Target: '@UI.FieldGroup#Cta' },
  ],
  UI.FieldGroup #General: { Data: [
    { Value: title }, { Value: body }, { Value: severity }, { Value: audience },
    { Value: active }, { Value: dismissible }
  ]},
  UI.FieldGroup #Scheduling: { Data: [ { Value: startsAt }, { Value: endsAt } ] },
  UI.FieldGroup #Cta: { Data: [ { Value: ctaLabel }, { Value: ctaUrl } ] },
);

annotate AdminService.Alerts {
  title       @Common.Label: 'Title';
  body        @Common.Label: 'Body';
  severity    @Common.Label: 'Severity'
              @Common.ValueListWithFixedValues: true
              @Common.ValueList: {
                CollectionPath: 'AlertSeverities',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: severity, ValueListProperty: 'code'  },
                  { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                ]
              }
              @assert.range: true;
  audience    @Common.Label: 'Audience'
              @Common.ValueListWithFixedValues: true
              @Common.ValueList: {
                CollectionPath: 'AlertAudiences',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: audience, ValueListProperty: 'code'  },
                  { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                ]
              }
              @assert.range: true;
  startsAt    @Common.Label: 'Start (UTC)';
  endsAt      @Common.Label: 'End (UTC)';
  active      @Common.Label: 'Active';
  dismissible @Common.Label: 'Dismissible';
  ctaLabel    @Common.Label: 'CTA label';
  ctaUrl      @Common.Label: 'CTA URL'
              @Common.ValueList: {
                CollectionPath: 'AlertCtaTargets',
                SearchSupported: true,
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',        LocalDataProperty: ctaUrl, ValueListProperty: 'url' },
                  { $Type: 'Common.ValueListParameterDisplayOnly',                              ValueListProperty: 'label' }
                ]
              }
              @Common.ValueListWithFixedValues: false;
};

// --- DormantAuthors (issue #622) ---
// Read-only recipient list backing the "Last Chance Emails" section. One
// row per FK-resolved author with >=1 stale active tutorial. Used both as
// a list/picker and (in a follow-up PR) as the surface for the
// sendLastChanceEmail / sendLastChanceEmailsAllDormant admin actions.
annotate AdminService.DormantAuthors with {
  authorEmail        @Common.Label: 'Email';
  authorName         @Common.Label: 'Author';
  tutorialCount      @Common.Label: 'Stale Tutorials';
  worstLevel         @Common.Label: 'Worst Level';
  oldestReviewedDate @Common.Label: 'Oldest Reviewed';
};

annotate AdminService.DormantAuthors with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'Dormant Author',
      TypeNamePlural : 'Dormant Authors',
      Title          : { Value: authorName },
      Description    : { Value: authorEmail }
    },
    Identification: [ { Value: authorEmail } ],
    SelectionFields: [ worstLevel ],
    LineItem: [
      { Value: authorName,         Label: 'Author' },
      { Value: authorEmail,        Label: 'Email' },
      { Value: tutorialCount,      Label: 'Stale Tutorials' },
      { Value: worstLevel,         Label: 'Worst Level' },
      { Value: oldestReviewedDate, Label: 'Oldest Reviewed' }
    ],
    PresentationVariant: {
      SortOrder: [
        { Property: worstLevel,         Descending: true  },
        { Property: oldestReviewedDate, Descending: false }
      ]
    }
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false,
  Capabilities.DeleteRestrictions.Deletable: false
);

// Homepage admin tile (#639)
annotate AdminService.HomepageShelves with @(
  UI.HeaderInfo : {
    TypeName       : 'Shelf entry',
    TypeNamePlural : 'Homepage shelves',
    Title          : { Value : title }
  },
  UI.LineItem : [
    { Value : verb,        Label : 'Verb' },
    { Value : shelf,       Label : 'Shelf' },
    { Value : sortOrder,   Label : 'Order' },
    { Value : title,       Label : 'Title' },
    { Value : url,         Label : 'URL' },
    { Value : badge,       Label : 'Badge' },
    { Value : linkStatus,  Label : 'Link health' },
    { Value : isActive,    Label : 'Active' }
  ],
  // (#759 hotfix) OP-header buttons for the per-link explainer workflow.
  // BOUND actions on the entity (srv/admin-service.cds) — FE V4 reads
  // UI.Identification and renders DataFieldForAction entries automatically.
  // Replaces PR 3b's broken manifest controlConfiguration[Identification].
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.HomepageShelves/regenerate',   Label: 'Regenerate explainer with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.HomepageShelves/markReviewed', Label: 'Mark explainer as reviewed' }
  ],
  UI.SelectionFields : [ verb, shelf, isActive, linkStatus ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'General',   Target: '@UI.FieldGroup#Main' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Main : { Data : [
    { Value : verb },
    { Value : shelf },
    { Value : sortOrder },
    { Value : title },
    { Value : url },
    { Value : description },
    { Value : badge },
    { Value : isExternal },
    { Value : isActive }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value : tagline,         Label : 'Tagline' },
    { Value : whyItMatters,    Label : 'Why it matters' },
    { Value : authoringStatus, Label : 'Authoring status' }
  ]}
);

annotate AdminService.HomepageShelves {
  verb            @Common.ValueListWithFixedValues @Common.Label: 'Verb';
  shelf           @Common.ValueListWithFixedValues @Common.Label: 'Shelf';
  badge           @Common.ValueListWithFixedValues @Common.Label: 'Badge';
  linkStatus      @Common.ValueListWithFixedValues @Common.Label: 'Link health';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
};

annotate AdminService.LegacyRedirects with @(
  UI.HeaderInfo : {
    TypeName       : 'Redirect',
    TypeNamePlural : 'Legacy redirects',
    Title          : { Value : fromPath }
  },
  UI.LineItem : [
    { Value : fromPath,   Label : 'From' },
    { Value : toPath,     Label : 'To' },
    { Value : statusCode, Label : 'Status' },
    { Value : isPattern,  Label : 'Regex?' },
    { Value : hitCount,   Label : 'Hits' },
    { Value : isActive,   Label : 'Active' }
  ],
  UI.SelectionFields : [ isActive, isPattern ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'General', Target: '@UI.FieldGroup#Main' }
  ],
  UI.FieldGroup #Main : { Data : [
    { Value : fromPath },
    { Value : toPath },
    { Value : statusCode },
    { Value : isPattern },
    { Value : isActive },
    // hitCount is observability-only; surface in the OP read-only.
    { Value : hitCount, @Common.FieldControl: #ReadOnly }
  ]}
);

annotate AdminService.LegacyRedirects {
  statusCode @Common.Label: 'HTTP status';
  fromPath   @Common.Label: 'From path';
  toPath     @Common.Label: 'To path';
  isPattern  @Common.Label: 'Regex pattern?';
  hitCount   @Common.Label: 'Hits';
};

annotate AdminService.HomepageConfig with @(
  UI.HeaderInfo : {
    TypeName       : 'Homepage config',
    TypeNamePlural : 'Homepage configs'
  },
  UI.FieldGroup #Main : { Data : [
    { Value : developerNewsPlaylistId, Label : 'Developer News playlist ID (YouTube)' },
    { Value : videoBandEnabled,        Label : 'Show video band' },
    { Value : eventsBandEnabled,       Label : 'Show events band' },
    { Value : communityLaneEnabled,    Label : 'Show community lane' }
  ]}
);

// (#759 PR 3b) Verb Definitions admin app annotations.
// CRUD locked down: cardinality is fixed at 6 (one per HomepageVerb
// enum value). Admins edit content fields (label, iconName, sortOrder,
// tagline, whyItMatters) but cannot Create or Delete rows. The
// verbKey + authoringStatus fields are read-only.
annotate AdminService.VerbDefinitions with @(
  Capabilities.InsertRestrictions.Insertable : false,
  Capabilities.DeleteRestrictions.Deletable  : false,
  Capabilities.UpdateRestrictions.Updatable  : true,
  UI.HeaderInfo : {
    TypeName: 'Verb',
    TypeNamePlural: 'Verb definitions',
    Title: { Value: label }
  },
  UI.LineItem : [
    { Value: verbKey,         Label: 'Verb key' },
    { Value: label,           Label: 'Label' },
    { Value: iconName,        Label: 'Icon' },
    { Value: sortOrder,       Label: 'Sort order' },
    { Value: authoringStatus, Label: 'Status', Criticality: authoringStatus }
  ],
  // (#759 hotfix) OP-header buttons via BOUND actions. FE V4 renders these
  // automatically as DataFieldForAction entries in the OP header — no
  // manifest `controlConfiguration[Identification]` needed. Same precedent
  // as KnowledgeGraphService.Concepts.publishConcept (admin-annotations.cds:2542).
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.VerbDefinitions/regenerate',   Label: 'Regenerate with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.VerbDefinitions/markReviewed', Label: 'Mark as reviewed' }
  ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'Identity',  Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Identity : { Data : [
    { Value: verbKey,    Label: 'Verb key' },
    { Value: label,      Label: 'Label' },
    { Value: iconName,   Label: 'Icon' },
    { Value: sortOrder,  Label: 'Sort order' }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value: tagline,         Label: 'Tagline' },
    { Value: whyItMatters,    Label: 'Why it matters' },
    { Value: authoringStatus, Label: 'Authoring status' }
  ]}
);

annotate AdminService.VerbDefinitions {
  verbKey         @Common.FieldControl: #ReadOnly @Common.Label: 'Verb key';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
};

// (#759 PR 3b) Shelf Definitions admin app annotations.
// CRUD locked down: cardinality is fixed at 4 (one per HomepageShelf
// enum value). Same conventions as VerbDefinitions above.
annotate AdminService.ShelfDefinitions with @(
  Capabilities.InsertRestrictions.Insertable : false,
  Capabilities.DeleteRestrictions.Deletable  : false,
  Capabilities.UpdateRestrictions.Updatable  : true,
  UI.HeaderInfo : {
    TypeName: 'Shelf category',
    TypeNamePlural: 'Shelf definitions',
    Title: { Value: label }
  },
  UI.LineItem : [
    { Value: shelfKey,        Label: 'Shelf key' },
    { Value: label,           Label: 'Label' },
    { Value: sortOrder,       Label: 'Sort order' },
    { Value: authoringStatus, Label: 'Status', Criticality: authoringStatus }
  ],
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.ShelfDefinitions/regenerate',   Label: 'Regenerate with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.ShelfDefinitions/markReviewed', Label: 'Mark as reviewed' }
  ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'Identity',  Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Identity : { Data : [
    { Value: shelfKey,   Label: 'Shelf key' },
    { Value: label,      Label: 'Label' },
    { Value: sortOrder,  Label: 'Sort order' }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value: tagline,         Label: 'Tagline' },
    { Value: whyItMatters,    Label: 'Why it matters' },
    { Value: authoringStatus, Label: 'Authoring status' }
  ]}
);

annotate AdminService.ShelfDefinitions {
  shelfKey        @Common.FieldControl: #ReadOnly @Common.Label: 'Shelf key';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
};
