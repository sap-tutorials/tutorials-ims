// app/admin-annotations.cds
using AdminService from '../srv/admin-service';

// --- Draft Enablement ---
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;
annotate AdminService.Prizes with @odata.draft.enabled;
annotate AdminService.Tutorials with @odata.draft.enabled;
// (#644 Task 9) Puzzles draft-enablement for admin authoring UI.
annotate AdminService.Puzzles with @odata.draft.enabled;
annotate AdminService.Puzzles with {
  slug     @Common.Label: 'Slug' @mandatory;
  title    @Common.Label: 'Title' @mandatory;
  intro    @Common.Label: 'Introduction (Markdown)' @UI.MultiLineText;
  layout   @Common.Label: 'Layout JSON';
  solution @Common.Label: 'Solution JSON';
};

// Puzzle-designer grid template library.
annotate AdminService.GridTemplates with @odata.draft.enabled;
annotate AdminService.GridTemplates with {
  name      @Common.Label: 'Template Name' @mandatory;
  rows      @Common.Label: 'Rows';
  cols      @Common.Label: 'Cols';
  blacks    @Common.Label: 'Black Cells JSON';
  isBuiltin @Common.Label: 'Built-in';
};

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
  qaPreviewUrl     @Common.Label: 'QA Preview'    @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'    @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Mission'  @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Mission'  @Common.FieldControl: #ReadOnly;
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
    { Value: status },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Mission' }
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
  // Path-item tutorial picker. Exposes slug / primaryTag / legacyIdStr as
  // DisplayOnly params so each becomes a VH-dialog column AND an individual
  // filter field — mirrors the redirectTo TutorialPickList picker
  // (srv/admin-service.cds:84). Free-text search across title/slug/
  // primaryTag/description is enabled by @cds.search on AdminService.Tutorials
  // (see srv/admin-service.cds). Without these, ~2000 tutorials paged behind a
  // title-only match hid valid rows like cp-aibus-dox-ui-sub.
  tutorial @Common.Text: tutorial.title @Common.TextArrangement: #TextOnly
           @Common.ValueList: {
             CollectionPath: 'Tutorials',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: tutorial_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'title' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'primaryTag' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyIdStr' }
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
  qaPreviewUrl     @Common.Label: 'QA Preview'  @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'  @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Group'  @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Group'  @Common.FieldControl: #ReadOnly;
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
    { Value: status },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Group' }
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
  // #918 — populated by after('READ', 'Tutorials') decorator in
  // admin-service.js from the KgIsolation sidecar.
  isolated              @Common.Label: 'Isolated'    @Common.FieldControl: #ReadOnly;
  // Lifecycle-link virtual fields (Task 4 — tutorial-lifecycle-links)
  sourceRepoUrl    @Common.Label: 'Source Repo (GitHub)'        @Common.FieldControl: #ReadOnly;
  sourceRepoLabel  @Common.Label: 'Source Repo'                 @Common.FieldControl: #ReadOnly;
  contribRepoUrl   @Common.Label: 'Contributions Repo (GitHub)' @Common.FieldControl: #ReadOnly;
  contribRepoLabel @Common.Label: 'Contributions Repo'          @Common.FieldControl: #ReadOnly;
  qaPreviewUrl     @Common.Label: 'QA Preview'                  @Common.FieldControl: #ReadOnly;
  qaPreviewLabel   @Common.Label: 'QA Preview'                  @Common.FieldControl: #ReadOnly;
  mainPreviewUrl   @Common.Label: 'Live Tutorial'               @Common.FieldControl: #ReadOnly;
  mainPreviewLabel @Common.Label: 'Live Tutorial'               @Common.FieldControl: #ReadOnly;
  owner            @Common.Label: 'Owner'                       @Common.FieldControl: #ReadOnly
                   @Common.ValueList: {
                     CollectionPath: 'TutorialOwnerPickList',
                     Parameters: [
                       { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: owner, ValueListProperty: 'owner' }
                     ]
                   };
  ownerEmail       @Common.Label: 'Owner Email'                 @Common.FieldControl: #ReadOnly;
};

annotate AdminService.TutorialMeta with {
  owner @Common.Label: 'Owner' @Common.FieldControl: #ReadOnly;
  ownerEmail @Common.Label: 'Owner Email' @Common.FieldControl: #ReadOnly;
};

annotate AdminService.Tutorials with @UI: {
  HeaderInfo: {
    TypeName: 'Tutorial', TypeNamePlural: 'Tutorials',
    Title: { Value: title },
    Description: { Value: slug }
  },
  SelectionFields: [ title, primaryTag, experienceTag, status, owner, ownerEmail, isolated ],
  LineItem: [
    { Value: legacyIdStr },
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: status },
    { Value: owner, Label: 'Owner' },
    { Value: ownerEmail, Label: 'Owner Email' },
    { Value: redirectTo.title, Label: 'Redirect To' },
    // #918 — Isolated column. Criticality 1 (Negative/red) when this
    // tutorial's WCC size is <= KG_WCC_ISOLATION_THRESHOLD (default 1).
    // 0 (Neutral) when false or null.
    {
      $Type: 'UI.DataField',
      Value: isolated,
      Label: 'Isolated',
      Criticality: { $edmJson: { $If: [ { $Path: 'isolated' }, 1, 0 ] } }
    },
    { Value: openHighCount, Label: 'Stale flags', Criticality: freshnessCriticality }
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
    { Value: owner, Label: 'Owner' },
    { Value: ownerEmail, Label: 'Owner Email' }
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
    },
    { $Type: 'UI.DataFieldForAction', Label: 'Check freshness', Action: 'AdminService.checkFreshness', ![@UI.Importance]: #High }
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
  login @Common.Label: 'GitHub';
  email @Common.Label: 'Email';
  role  @Common.Label: 'Role';
};

annotate AdminService.TutorialContributors with @UI.LineItem: [
  { Value: name },
  { $Type: 'UI.DataFieldWithUrl', Value: login, Url: profileUrl, Label: 'GitHub' },
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
    { Value: meta.repository.name, Label: 'Source Repository' },
    { $Type: 'UI.DataFieldWithUrl', Value: sourceRepoLabel,  Url: sourceRepoUrl,  Label: 'Source Repo (GitHub)' },
    { $Type: 'UI.DataFieldWithUrl', Value: contribRepoLabel, Url: contribRepoUrl, Label: 'Contributions Repo (GitHub)' },
    { $Type: 'UI.DataFieldWithUrl', Value: qaPreviewLabel,   Url: qaPreviewUrl,   Label: 'QA Preview' },
    { $Type: 'UI.DataFieldWithUrl', Value: mainPreviewLabel, Url: mainPreviewUrl, Label: 'Live Tutorial' }
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

// TutorialValidationRules — all validation rules for a tutorial (step, question,
// type, rule, AI-grading flag, correct answer). Joined via `validationRules` association.
annotate AdminService.TutorialValidationRules with @(
  UI.LineItem: [
    { Value: stepNumber,   Label: 'Step' },
    { Value: questionText,  Label: 'Question' },
    { Value: questionType,  Label: 'Type' },
    { Value: ruleType,      Label: 'Rule' },
    { Value: aiGrading,     Label: 'AI-Graded' },
    { Value: correctAnswer, Label: 'Correct Answer' }
  ]
);

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
// FreshnessFacet (spec 2026-08-22-tutorial-freshness-detector) is appended
// in the same block further below.
annotate AdminService.Tutorials with @UI: {
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',  Label: 'General',  Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' },
    { $Type: 'UI.ReferenceFacet', Label: 'Categories', ID: 'CategoriesFacet', Target: 'categories/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Steps', ID: 'StepsFacet', Target: 'steps/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Contributors', ID: 'ContributorsFacet', Target: 'contributors/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Completion Stats', ID: 'CompletionStatsFacet',
      Target: 'completionStats/@UI.FieldGroup#Stats' },
    { $Type: 'UI.ReferenceFacet', Label: 'AI-Graded Validation', ID: 'ValidationSpecsFacet',
      Target: 'validationSpecs/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'All Validation Rules', ID: 'AllValidationRulesFacet',
      Target: 'validationRules/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Code-Check Specs', ID: 'CodeCheckSpecsFacet',
      Target: 'codeCheckSpecs/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'AI-Author Requests', ID: 'AiRequestsFacet',
      Target: 'aiRequests/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Freshness Reports', ID: 'FreshnessReportsFacet', Target: 'freshnessReports/@UI.PresentationVariant' },
    { $Type: 'UI.ReferenceFacet', ID: 'FreshnessFacet', Label: 'Freshness',
      Target: 'freshnessFindings/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Images', ID: 'MediaImagesFacet', Target: 'images/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Assets', ID: 'MediaAssetsFacet', Target: 'assets/@UI.LineItem' },
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
  taskLegacyId  @Common.Label: 'Featured item'
                // @UI.RecommendationState: 0 opts this field out of the @cap-js/ai
                // RPT-1 recommendation hook (docs/developers/reference/cap-ai-plugin.md).
                // FeaturedTasks is @odata.draft.enabled and now has an editable
                // ObjectPage (#1551), so a draft POST → read-after-write on this
                // @Common.ValueList field would otherwise fire the plugin handler,
                // call cds.connect.to('AICore') and throw "No service definition
                // found for 'AICore'" on CF — surfacing as "Internal Server Error"
                // on Create. Same escape as HomepageForYouCandidatesAdmin.
                @UI.RecommendationState: 0
                @Common.ValueList: {
                  CollectionPath: 'FeaturedTaskCandidates',
                  Parameters: [
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskLegacyId, ValueListProperty: 'taskLegacyId' },
                    { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: taskType,     ValueListProperty: 'taskType'     },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                                  ValueListProperty: 'title'        },
                    { $Type: 'Common.ValueListParameterDisplayOnly',                                  ValueListProperty: 'slug'         }
                  ]
                };
  taskType      @Common.Label: 'Type' @UI.ReadOnly;
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
  ],
  // #1551: row-click now navigates to an editable ObjectPage. Facets +
  // FieldGroup give the detail page fields to render.
  Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General', Target: '@UI.FieldGroup#General' }
  ],
  FieldGroup #General: { Data: [
    { Value: taskLegacyId },
    { Value: taskType },
    { Value: featuredOrder }
  ]}
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

// --- Devtoberfest Signups (aggregated report — spec 2026-08-13; readable-axis
//     + total-KPI + breakdowns rework for issue #2047) --------------------------
//
// Analytical List Page over the per-signup fact view. Native OData $apply drives
// the chart + analytical table + filter bar (group by week / edition / region /
// role, aggregate signup count, grand total).
//
// Time axis: the chart and table group+sort on the REAL Date column `weekMonday`
// (portable per dialect — db/sqlite/native.cds strftime, db/hana/native.cds
// ADD_DAYS) and DISPLAY the readable `weekStartText` label via #TextOnly text
// arrangement — so the axis reads "Mon 07 Sep 2026" (HANA) / the ISO Monday date
// (local SQLite) as a category, never the raw integer bucket or a thinned Date
// axis. The internal `weekIndex` is hidden (kept only to derive weekMonday) and
// is NOT a user-facing dimension anymore (it used to leak as "449/451" — #2047).
// weekLabel ('YYYY-Www') + cumulativeSignups are read-handler enrichment fields
// (srv/lib/devtoberfest-signup-enrich.js), display-only, never $apply dimensions.
annotate AdminService.DevtoberfestSignupAnalytics with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ weekMonday, weekStartText, eventName, eventType, region, role ],
    AggregatableProperties: [ { Property: signups } ]
  },
  Analytics.AggregatedProperty #newSignups: {
    Name: 'newSignups',
    AggregationMethod: 'sum',
    AggregatableProperty: signups,
    ![@Common.Label]: 'New Signups'
  },
  // Overall total registrations as a prominent, LABELLED KPI header card (#2047).
  // SUM(signups) with no filter → grand total across all Devtoberfest signups.
  UI.DataPoint #totalSignups: {
    Value: signups,
    Title: 'Total Registrations'
  },
  UI.PresentationVariant #totalSignups: {
    Visualizations: ['@UI.DataPoint#totalSignups']
  },
  UI.SelectionVariant #totalSignups: {
    SelectOptions: []
  },
  UI.KPI #totalSignups: {
    SelectionVariant           : ![@UI.SelectionVariant#totalSignups],
    DataPoint                  : ![@UI.DataPoint#totalSignups],
    ![@UI.PresentationVariant] : ![@UI.PresentationVariant#totalSignups]
  },
  // Default breakdown: signups per calendar week. The chart groups on the real
  // Date column weekMonday and shows its readable weekStartText label (#2047).
  UI.Chart: {
    ChartType: #Column,
    Dimensions: [weekMonday],
    DynamicMeasures: ['@Analytics.AggregatedProperty#newSignups']
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: weekMonday }]
  },
  // Alternate breakdowns, one click away via the page's variant management. Every
  // GroupableProperty is also reachable through the chart's dimension drill-down.
  UI.Chart #byRegion: {
    ChartType: #Column,
    Dimensions: [region],
    DynamicMeasures: ['@Analytics.AggregatedProperty#newSignups']
  },
  UI.PresentationVariant #byRegion: {
    Visualizations: ['@UI.Chart#byRegion', '@UI.LineItem'],
    SortOrder: [{ Property: newSignups, Descending: true }]
  },
  UI.SelectionPresentationVariant #byRegion: {
    Text                : 'By Region',
    SelectionVariant    : { SelectOptions: [] },
    PresentationVariant : ![@UI.PresentationVariant#byRegion]
  },
  UI.Chart #byEdition: {
    ChartType: #Column,
    Dimensions: [eventName],
    DynamicMeasures: ['@Analytics.AggregatedProperty#newSignups']
  },
  UI.PresentationVariant #byEdition: {
    Visualizations: ['@UI.Chart#byEdition', '@UI.LineItem'],
    SortOrder: [{ Property: newSignups, Descending: true }]
  },
  UI.SelectionPresentationVariant #byEdition: {
    Text                : 'By Edition',
    SelectionVariant    : { SelectOptions: [] },
    PresentationVariant : ![@UI.PresentationVariant#byEdition]
  },
  UI.Chart #byRole: {
    ChartType: #Column,
    Dimensions: [role],
    DynamicMeasures: ['@Analytics.AggregatedProperty#newSignups']
  },
  UI.PresentationVariant #byRole: {
    Visualizations: ['@UI.Chart#byRole', '@UI.LineItem'],
    SortOrder: [{ Property: newSignups, Descending: true }]
  },
  UI.SelectionPresentationVariant #byRole: {
    Text                : 'By Role',
    SelectionVariant    : { SelectOptions: [] },
    PresentationVariant : ![@UI.PresentationVariant#byRole]
  },
  UI.SelectionFields: [ eventName, region, role ],
  UI.LineItem: [
    { Value: weekMonday,        Label: 'Week Starting' },
    { Value: eventName,         Label: 'Edition' },
    { Value: region,            Label: 'Region' },
    { Value: role,              Label: 'Role' },
    { Value: newSignups,        Label: 'New Signups' },
    { Value: cumulativeSignups, Label: 'Cumulative (running total)' }
  ]
) {
  ID            @UI.Hidden;
  weekMonday    @title: 'Week Starting'  @Analytics.Dimension
                @Common: { Text: weekStartText, TextArrangement: #TextOnly };
  weekStartText @title: 'Week Starting'  @Analytics.Dimension  @UI.Hidden;
  weekIndex     @title: 'Week #'         @UI.Hidden;
  eventName     @title: 'Edition'        @Analytics.Dimension;
  eventType     @title: 'Event Type'     @Analytics.Dimension;
  region        @title: 'Region'         @Analytics.Dimension;
  role          @title: 'Role'           @Analytics.Dimension;
  signups       @title: 'Signups'        @Analytics.Measure @Aggregation.default: #SUM;
  weekLabel     @title: 'Calendar Week';
  cumulativeSignups @title: 'Cumulative (running total)';
};

// Filter-bar value help. eventName resolves against Events (edition picker);
// region/role are fixed-value dropdowns mirroring the UserLearningPreferences
// enums plus the 'Not set' bucket (served from srv/admin-service.js).
annotate AdminService.DevtoberfestSignupAnalytics with {
  eventName @Common.ValueList: {
    CollectionPath: 'Events',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: eventName, ValueListProperty: 'name' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'startDate' }
    ]
  };
  region @Common.ValueListWithFixedValues @Common.ValueList: {
    CollectionPath: 'SignupRegions',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: region, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
    ]
  };
  role @Common.ValueListWithFixedValues @Common.ValueList: {
    CollectionPath: 'SignupRoles',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: role, ValueListProperty: 'code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'label' }
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
  a2aEnabled         @Common.Label: 'A2A Enabled' @description: 'Master switch for the /a2a endpoint and Agent Card. When off, /a2a returns 503 and the card signals unavailability.';
  a2aPublicBaseUrl   @Common.Label: 'A2A Public Base URL' @description: 'Base URL advertised in the Agent Card url; blank = auto-detect from platform (VCAP application_uris).';
  a2aTokenUrl        @Common.Label: 'A2A Token URL' @description: 'OAuth token endpoint advertised in the Agent Card xsuaa security scheme.';
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
  SelectionFields: [ deployment, role ],
  LineItem: [
    { Value: user.email },
    { Value: user.displayName },
    { Value: deployment },
    { Value: role },
    { Value: modifiedAt }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Preferences' }
  ],
  FieldGroup#General: { Data: [
    { Value: user.email }, { Value: deployment }, { Value: role }
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

// DevtoberfestBanner — the image bytes are written via the `uploadBanner`
// bound action (sharp → WebP → BLOB), invoked from the Object Page header
// action in the devtoberfest admin app. It is intentionally NOT surfaced as a
// Fiori UploadSet / LineItem facet: FE would render a table whose "Create"
// POSTs a new row to a composition-of-one whose key IS the parent association,
// which OData rejects with "Method POST is not allowed for singletons and
// individual entities" (confirmed live on DEV 2026-07-29).
annotate AdminService.DevtoberfestBanner with {
  image  @Common.Label: 'Banner Image'  @Core.ContentDisposition: { Filename: 'devtoberfest-banner.webp' };
};

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
  // #1080 — virtual Boolean projection of `publishedAt IS NOT NULL`.
  // Populated by after('READ', 'Concepts'); filterable via a
  // before('READ') CQN rewrite. Read-only — no PATCH path.
  isPublished     @Common.Label: 'Published?'     @Common.FieldControl: #ReadOnly;
  // #918 — populated by after('READ', 'Concepts') decorator in
  // knowledge-graph-service.js from the KgIsolation sidecar.
  isolated        @Common.Label: 'Isolated'       @Common.FieldControl: #ReadOnly;
};

annotate KnowledgeGraphService.Concepts with @(
  UI.HeaderInfo: {
    TypeName       : 'Concept',
    TypeNamePlural : 'Concepts',
    Title          : { Value: name },
    Description    : { Value: slug }
  },

  UI.SelectionFields: [ status, isPublished, slug, isolated ],

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
    // #918 — Isolated column. Criticality 1 (Negative/red) when the
    // vertex sits in a small WCC (default: size 1). 0 (Neutral) when
    // false or null. OData V4 CriticalityType: 0=Neutral, 1=Negative,
    // 2=Critical, 3=Positive. Mirrors the publishedAt $edmJson pattern
    // above.
    {
      $Type: 'UI.DataField',
      Value: isolated,
      Label: 'Isolated',
      Criticality: { $edmJson: { $If: [ { $Path: 'isolated' }, 1, 0 ] } }
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
    { $Type: 'UI.ReferenceFacet', Label: 'Incoming edges',  Target: 'incomingEdges/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'Aliases',         Target: 'aliases/@UI.LineItem' }
  ],

  // Phase 3 (#446) — Publish / Unpublish toolbar actions.
  // BOUND actions on Concepts so Fiori Elements V4 uses the selected-row
  // context — no parameter dialog. The Action reference matches the canonical
  // form used by AdminService.Tutorials/rebuildContent at line 609 above
  // (`<Service>.<actionName>`; FE V4 resolves the binding from context).
  //
  // #1080 "Publish All Unpublished" is UNBOUND (no row-context) and needs
  // a confirmation dialog — wired via app/admin/concepts/webapp/manifest.json
  // + ConceptActionsController.onPublishAllConcepts, mirroring the existing
  // previewMerges / triggerGraphRebuild toolbar buttons.
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

// --- #1046 ConceptAliases — inline sub-table on the Concept OP "Aliases" facet
annotate KnowledgeGraphService.ConceptAliases with {
  alias      @Common.Label: 'Alias';
  source     @Common.Label: 'Source';
  modifiedAt @Common.Label: 'Modified At';
};

annotate KnowledgeGraphService.ConceptAliases with @UI: {
  LineItem: [
    { $Type: 'UI.DataField', Value: alias,      Label: 'Alias' },
    { $Type: 'UI.DataField', Value: source,     Label: 'Source' },
    { $Type: 'UI.DataField', Value: modifiedAt, Label: 'Modified At' }
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
  edition           @title: 'Devtoberfest Edition'
                    @Common.Label: 'Devtoberfest Edition'
                    @Common.Text: edition.NAME @Common.TextArrangement: #TextOnly
                    @Common.ValueList: {
                      Label: 'Edition',
                      CollectionPath: 'DevtoberfestEditionPickList',
                      Parameters: [
                        { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: edition_ID, ValueListProperty: 'ID' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'NAME' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'YEAR' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'STARTSAT' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ENDSAT' },
                        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'ISCURRENT' }
                      ]
                    };
  termsText         @title: 'Content Rules (markdown)'
                    @Common.Label: 'Content Rules (markdown)'
                    @UI.MultiLineText;
  faqText           @title: 'FAQ (markdown)'
                    @Common.Label: 'FAQ (markdown)'
                    @UI.MultiLineText;
  termsVersion      @title: 'Terms Version' @Common.Label: 'Terms Version';
  contentRulesUrl   @title: 'Content Rules URL' @Common.Label: 'Content Rules URL';
  faqUrl            @title: 'FAQ URL' @Common.Label: 'FAQ URL';
  gameboardUrl      @title: 'Gameboard URL' @Common.Label: 'Gameboard URL';
  activitiesUrl     @title: 'Activities URL' @Common.Label: 'Activities URL';
  hasBanner         @title: 'Banner uploaded' @Common.Label: 'Banner uploaded';
  bannerUpdatedAt   @title: 'Banner last updated' @Common.Label: 'Banner last updated';
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
  SelectionFields: [ isActive, currentEvent_ID, edition_ID ],
  LineItem: [
    { Value: currentEvent.name,      Label: 'Event' },
    { Value: edition.NAME,           Label: 'Edition' },
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
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Terms',    Label: 'Content Rules, Terms & FAQ' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SubPages', Label: 'Sub-pages (leave blank to hide)' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Banner',   Label: 'Event Banner' }
  ],
  FieldGroup#General: { Data: [
    { Value: currentEvent_ID, Label: 'Event' },
    { Value: edition_ID, Label: 'Devtoberfest Edition' },
    { Value: isActive },
    { Value: termsVersion }
  ]},
  FieldGroup#Terms: { Data: [
    { Value: termsText },
    { Value: faqText }
  ]},
  FieldGroup#SubPages: { Data: [
    { Value: contentRulesUrl },
    { Value: faqUrl },
    { Value: gameboardUrl },
    { Value: activitiesUrl }
  ]},
  // Banner status (read-only). The image itself is uploaded via the header
  // actions `uploadBanner`/`clearBanner` (wired in the devtoberfest admin app
  // manifest to a controller that POSTs the file to the bound action) — NOT a
  // Fiori UploadSet, which cannot create a row on a 1:1 composition whose key
  // IS the parent association ("POST is not allowed for singletons and
  // individual entities", confirmed live on DEV 2026-07-29).
  FieldGroup#Banner: { Data: [
    { Value: hasBanner,       Label: 'Banner uploaded' },
    { Value: bannerUpdatedAt, Label: 'Banner last updated' }
  ]}
};

// Value-help dialog columns for the Edition picker.
annotate AdminService.DevtoberfestEditionPickList with {
  ID        @Common.Label: 'Edition ID';
  NAME      @Common.Label: 'Name';
  YEAR      @Common.Label: 'Year';
  STARTSAT  @Common.Label: 'Start';
  ENDSAT    @Common.Label: 'End';
  TIMEZONE  @Common.Label: 'Time Zone';
  ISCURRENT @Common.Label: 'Is Current';
};

annotate AdminService.DevtoberfestEditionPickList with @(
  UI: {
    HeaderInfo: { TypeName: 'Edition', TypeNamePlural: 'Editions', Title: { Value: NAME } },
    SelectionFields: [ NAME, YEAR, ISCURRENT ],
    LineItem: [
      { Value: NAME },
      { Value: YEAR },
      { Value: STARTSAT },
      { Value: ENDSAT },
      { Value: ISCURRENT }
    ]
  }
);

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
  body        @Common.Label: 'Body'  @UI.MultiLineText;
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
              // @UI.RecommendationState: 0 opts this field out of the @cap-js/ai
              // RPT-1 recommendation hook (docs/developers/reference/cap-ai-plugin.md).
              // Alerts is @odata.draft.enabled, so without this the plugin renders
              // ctaUrl as a recommendation field that validates input against the
              // AlertCtaTargets value-list and DISCARDS free-typed URLs (e.g.
              // "/whats-new/") on Enter/commit — even though ValueListWithFixedValues
              // is false. The value-help below is meant as quick-pick suggestions
              // only; admins must be able to type any URL. Same escape hatch as
              // FeaturedTasks.taskLegacyId / HomepageForYouCandidatesAdmin.personaTags.
              @UI.RecommendationState: 0
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
    { Value : requiresLogin, Label : 'Sign-in required' },
    { Value : isActive,    Label : 'Active' }
  ],
  // (#759 hotfix) OP-header buttons for the per-link explainer workflow.
  // BOUND actions on the entity (srv/admin-service.cds) — FE V4 reads
  // UI.Identification and renders DataFieldForAction entries automatically.
  // Replaces PR 3b's broken manifest controlConfiguration[Identification].
  // (#1532) Action string MUST be the bare 'Service.action' form. regenerate /
  // markReviewed are 3-way OVERLOADED bound actions (HomepageShelves +
  // VerbDefinitions + ShelfDefinitions); ODataMetaModel returns the overload
  // array for 'AdminService.regenerate' and FE selects the overload matching
  // the OP binding-context entity type. The 'Service.Entity/action' slash form
  // is misparsed as an unbound *action import* (none exists) → FE throws
  // "Unknown action import" in callActionImport, swallows it, and the button
  // silently no-ops. Same root cause + fix as petoberfest approve/hide (25faff53).
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.regenerate',   Label: 'Regenerate explainer with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.markReviewed', Label: 'Mark explainer as reviewed' }
  ],
  UI.SelectionFields : [ verb, shelf, isActive, linkStatus ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'General',         Target: '@UI.FieldGroup#Main' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer',       Target: '@UI.FieldGroup#Explainer' },
    { $Type: 'UI.ReferenceFacet', ID: 'PersonalizationFacet', Label: 'Personalization', Target: '@UI.FieldGroup#Personalization' }
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
    { Value : requiresLogin },
    { Value : isActive },
    { Value : linkStatusOverride, Label : 'Link health override (blank = auto-detect)' }
  ]},
  UI.FieldGroup #Explainer : { Data : [
    { Value : tagline,         Label : 'Tagline' },
    { Value : whyItMatters,    Label : 'Why it matters' },
    { Value : authoringStatus, Label : 'Authoring status' }
  ]},
  UI.FieldGroup #Personalization : { Data : [
    { Value : personaTags,   Label : 'Persona tags (positive)' },
    { Value : personaWeight, Label : 'Persona weight' },
    { Value : personaHidden, Label : 'Persona hidden (exclude)' }
  ]}
);

annotate AdminService.HomepageShelves {
  // verb & shelf carry BOTH @Common.ValueListWithFixedValues (inline dropdown
  // render) AND the record-form @Common.ValueList (CollectionPath). The latter
  // is what makes them RPT-1-eligible — @cap-js/ai keys on
  // @Common.ValueList.CollectionPath (node_modules/@cap-js/ai/lib/csn-enhancements/
  // recommendations.js:32), which @Common.ValueListWithFixedValues alone does
  // not set. VerbChoices/ShelfChoices are @cds.persistence.skip {code,label}
  // code lists served in-memory from srv/admin-service.js. Per-field opt-out:
  // @UI.RecommendationState: 0.
  verb            @Common.ValueListWithFixedValues @Common.Label: 'Verb'
                  @Common.ValueList: {
                    CollectionPath: 'VerbChoices',
                    Parameters: [
                      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: verb, ValueListProperty: 'code'  },
                      { $Type: 'Common.ValueListParameterDisplayOnly',                          ValueListProperty: 'label' }
                    ]
                  };
  shelf           @Common.ValueListWithFixedValues @Common.Label: 'Shelf'
                  @Common.ValueList: {
                    CollectionPath: 'ShelfChoices',
                    Parameters: [
                      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: shelf, ValueListProperty: 'code'  },
                      { $Type: 'Common.ValueListParameterDisplayOnly',                           ValueListProperty: 'label' }
                    ]
                  };
  badge           @Common.ValueListWithFixedValues @Common.Label: 'Badge';
  linkStatus             @Common.ValueListWithFixedValues @Common.Label: 'Link health';
  // linkStatusOverride: a bare String-enum type does not reliably materialise a
  // Fiori dropdown from @Common.ValueListWithFixedValues alone, so pair it with
  // an explicit code list (LinkStatusChoices, served in-memory) exactly like
  // verb/shelf. Blank clears the override → auto-detect resumes next run.
  linkStatusOverride     @Common.ValueListWithFixedValues @Common.Label: 'Link health override (blank = auto-detect)'
                  // Opt out of RPT-1: adding a @Common.ValueList.CollectionPath makes the
                  // field @cap-js/ai-eligible, which auto-hooks AICore and can throw
                  // "No service definition found for 'AICore'" → Internal Server Error on
                  // the OP (see personaTags below + memory: cap-ai-plugin-aicore-kind-resolution).
                  // A 3-value link-health picker has nothing to recommend anyway.
                  @UI.RecommendationState: 0
                  @Common.ValueList: {
                    CollectionPath: 'LinkStatusChoices',
                    Parameters: [
                      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: linkStatusOverride, ValueListProperty: 'code'  },
                      { $Type: 'Common.ValueListParameterDisplayOnly',                                        ValueListProperty: 'label' }
                    ]
                  };
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
  // (#1552) Labels for the remaining OP form fields. The OP FieldGroup #Main
  // record entries carry no inline `Label:`, so without a @Common.Label these
  // rendered with the technical element name on the edit detail screen.
  sortOrder    @Common.Label: 'Sort order';
  title        @Common.Label: 'Title';
  url          @Common.Label: 'URL'  @UI.MultiLineText;
  description  @Common.Label: 'Description'  @UI.MultiLineText;
  isExternal   @Common.Label: 'Opens in new tab';
  isActive     @Common.Label: 'Active';
  requiresLogin @Common.Label: 'Sign-in required';
  tagline      @Common.Label: 'Tagline'  @UI.MultiLineText;
  whyItMatters @Common.Label: 'Why it matters'  @UI.MultiLineText;
  lastChecked  @Common.Label: 'Last checked';
  // (#763) Persona facet fields
  personaTags   @Common.Label: 'Persona tags (positive)' @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaTags, ValueListProperty: 'tag' }]
  };
  personaWeight @Common.Label: 'Persona weight';
  personaHidden @Common.Label: 'Persona hidden (exclude)' @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaHidden, ValueListProperty: 'tag' }]
  };
};

// (#1552) SideEffects so the OP-header explainer actions refresh the row after
// they run. Without this, invoking `regenerate` / `markReviewed` in DISPLAY
// mode returned 200 but the page kept showing the old tagline / whyItMatters /
// authoringStatus until a manual reload — the admin saw "nothing happened".
// TargetProperties are relative to the action's binding parameter (`_it`), the
// FE V4 convention for a bound-action self-refresh. Draft (edit-mode) writes
// already round-trip through the draft shadow (srv/admin-service.js #1552), but
// the annotation applies to both overloads so display + edit both refresh.
annotate AdminService.HomepageShelves actions {
  regenerate   @(Common.SideEffects: { TargetProperties: ['_it/tagline', '_it/whyItMatters', '_it/authoringStatus'] });
  markReviewed @(Common.SideEffects: { TargetProperties: ['_it/authoringStatus'] });
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
  fromPath   @Common.Label: 'From path'  @UI.MultiLineText;
  toPath     @Common.Label: 'To path'  @UI.MultiLineText;
  isPattern  @Common.Label: 'Regex pattern?';
  hitCount   @Common.Label: 'Hits';
};

// HomepageConfig is a @odata.singleton — the Object Page renders standalone
// (no LR list). It MUST declare UI.Facets that reference the field group;
// without a facet, FE V4 renders only the header + Delete button and the
// form body stays blank (repro: #948/#1010 follow-up — page opened blank).
annotate AdminService.HomepageConfig with @(
  UI.HeaderInfo : {
    TypeName       : 'Homepage config',
    TypeNamePlural : 'Homepage configs',
    Title          : { Value : 'Homepage config' }
  },
  UI.Facets : [
    { $Type : 'UI.ReferenceFacet', ID : 'MainFacet', Label : 'General',
      Target : '@UI.FieldGroup#Main' }
  ],
  UI.FieldGroup #Main : { Data : [
    { Value : developerNewsPlaylistId, Label : 'Developer News playlist ID (YouTube)' },
    { Value : videoBandEnabled,        Label : 'Show video band' },
    { Value : eventsBandEnabled,       Label : 'Show events band' },
    { Value : communityLaneEnabled,    Label : 'Show community lane' },
    // (#763) Master kill switch for the personalized-homepage feature.
    // Default false at first migration; admin flips this on to expose
    // the "Personalized for you · Adjust · See default" badge and the
    // For-You row on the homepage. Without the toggle rendered here,
    // /homepage/personalized 204s and the badge never injects.
    { Value : personalizationEnabled,  Label : 'Enable personalized homepage' },
    // (#1031) Video band expand + rotation tuning knobs.
    { Value : videoBandAnchorCount,        Label : 'Video band anchor slots' },
    { Value : videoBandRotationCount,      Label : 'Video band rotation slots' },
    { Value : videoBandRotationWindowDays, Label : 'Rotation window (days)' },
    // Base URL the link-health job resolves root-relative shelf / For-You
    // links against (blank → https://developers.sap.com). Set the DEV
    // approuter URL here so internal links aren't checked against PROD.
    { Value : publicBaseUrl,               Label : 'Public site base URL (internal link checks)' }
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
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.regenerate',   Label: 'Regenerate with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.markReviewed', Label: 'Mark as reviewed' }
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
  // (#1552) Element-level labels so every surface (LineItem, form, filters)
  // shows a friendly name, not the technical element id.
  label        @Common.Label: 'Label';
  iconName     @Common.Label: 'Icon';
  sortOrder    @Common.Label: 'Sort order';
  tagline      @Common.Label: 'Tagline'  @UI.MultiLineText;
  whyItMatters @Common.Label: 'Why it matters'  @UI.MultiLineText;
};

// (#1552) OP-header explainer action self-refresh — see HomepageShelves above.
annotate AdminService.VerbDefinitions actions {
  regenerate   @(Common.SideEffects: { TargetProperties: ['_it/tagline', '_it/whyItMatters', '_it/authoringStatus'] });
  markReviewed @(Common.SideEffects: { TargetProperties: ['_it/authoringStatus'] });
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
    { Value: iconName,        Label: 'Icon' },
    { Value: sortOrder,       Label: 'Sort order' },
    { Value: authoringStatus, Label: 'Status', Criticality: authoringStatus }
  ],
  UI.Identification : [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.regenerate',   Label: 'Regenerate with AI' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.markReviewed', Label: 'Mark as reviewed' }
  ],
  UI.Facets : [
    { $Type: 'UI.ReferenceFacet', Label: 'Identity',  Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', Label: 'Explainer', Target: '@UI.FieldGroup#Explainer' }
  ],
  UI.FieldGroup #Identity : { Data : [
    { Value: shelfKey,   Label: 'Shelf key' },
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

annotate AdminService.ShelfDefinitions {
  shelfKey        @Common.FieldControl: #ReadOnly @Common.Label: 'Shelf key';
  authoringStatus @Common.FieldControl: #ReadOnly @Common.Label: 'Authoring status';
  // (#1552) Element-level labels — see VerbDefinitions above.
  label        @Common.Label: 'Label';
  iconName     @Common.Label: 'Icon';
  sortOrder    @Common.Label: 'Sort order';
  tagline      @Common.Label: 'Tagline'  @UI.MultiLineText;
  whyItMatters @Common.Label: 'Why it matters'  @UI.MultiLineText;
};

// (#1552) OP-header explainer action self-refresh — see HomepageShelves above.
annotate AdminService.ShelfDefinitions actions {
  regenerate   @(Common.SideEffects: { TargetProperties: ['_it/tagline', '_it/whyItMatters', '_it/authoringStatus'] });
  markReviewed @(Common.SideEffects: { TargetProperties: ['_it/authoringStatus'] });
};

// --- HomepageForYouCandidates (#763 Task 18) ---
// List report + Object Page for the "For You" row candidate pool.
// The entity is @odata.draft.enabled from Task 8 (app/admin-annotations.cds —
// the draft annotation lives on the AdminService projection there, not here).
// PersonaTagChoices value help was introduced in Task 17 and is reused directly.
annotate AdminService.HomepageForYouCandidatesAdmin with @(
  UI.LineItem: [
    { Value: title,        Label: 'Title' },
    { Value: kind,         Label: 'Kind' },
    { Value: targetSlug,   Label: 'Target' },
    { Value: personaTags,  Label: 'Persona tags' },
    { Value: personaWeight, Label: 'Weight' },
    { Value: active,       Label: 'Active' },
    { Value: sortOrder,    Label: 'Sort' },
    { Value: modifiedAt,   Label: 'Updated' },
  ],
  UI.HeaderInfo: {
    TypeName: 'For-you candidate',
    TypeNamePlural: 'For-you candidates',
    Title: { Value: title },
    Description: { Value: kind },
  },
  UI.FieldGroup #Main: {
    Data: [
      { Value: kind },
      { Value: targetSlug },
      { Value: title },
      { Value: description },
      { Value: imageUrl },
      { Value: sortOrder },
      { Value: active },
      { Value: linkStatusOverride, Label: 'Link health override (blank = auto-detect)' },
    ]
  },
  UI.FieldGroup #Personalization: {
    Data: [
      { Value: personaTags,   Label: 'Persona tags (positive)' },
      { Value: personaWeight, Label: 'Persona weight' },
      { Value: personaHidden, Label: 'Persona hidden (exclude)' },
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'MainFacet',            Label: 'General',
      Target: '@UI.FieldGroup#Main' },
    { $Type: 'UI.ReferenceFacet', ID: 'PersonalizationFacet', Label: 'Personalization',
      Target: '@UI.FieldGroup#Personalization' },
  ],
);

annotate AdminService.HomepageForYouCandidatesAdmin with {
  // @UI.RecommendationState: 0 opts these two fields out of the @cap-js/ai
  // RPT-1 recommendation hook (docs/developers/reference/cap-ai-plugin.md).
  // Without the opt-out, draft POST → read-after-write fires the plugin's
  // handler at @cap-js/ai/lib/handlers/recommendations.js:99, which calls
  // cds.connect.to('AICore') and throws "No service definition found for
  // 'AICore'" on CF DEV (the aicore VCAP binding is present, but the
  // plugin's profile-default kind resolution isn't landing) — surfaces to
  // the user as "Internal Server Error" on Create. RPT-1 predictions add
  // nothing here anyway: PersonaTagChoices is a small fixed enum, not the
  // free-text ValueList the plugin is designed for.
  personaTags   @Common.Label: 'Persona tags (positive)'
                @UI.RecommendationState: 0
                @Common.ValueList: {
                  CollectionPath: 'PersonaTagChoices',
                  Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                                 LocalDataProperty: personaTags, ValueListProperty: 'tag' }]
                };
  personaHidden @Common.Label: 'Persona hidden (exclude)'
                @UI.RecommendationState: 0
                @Common.ValueList: {
                  CollectionPath: 'PersonaTagChoices',
                  Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                                 LocalDataProperty: personaHidden, ValueListProperty: 'tag' }]
                };
  linkStatusOverride @Common.ValueListWithFixedValues @Common.Label: 'Link health override (blank = auto-detect)'
                  @UI.RecommendationState: 0  // see HomepageShelves.linkStatusOverride above (RPT-1/AICore opt-out)
                  @Common.ValueList: {
                    CollectionPath: 'LinkStatusChoices',
                    Parameters: [
                      { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: linkStatusOverride, ValueListProperty: 'code'  },
                      { $Type: 'Common.ValueListParameterDisplayOnly',                                        ValueListProperty: 'label' }
                    ]
                  };
};

// --- KG Communities (#917) ---
// LR-facing aggregate over ims.KgCommunitySummaryV. Two columns of note:
//   * topConceptSlugs — up to 3 concept slugs per community, populated
//     by the after('READ', 'KgCommunities') handler in srv/admin-service.js
//   * alreadyPromoted — materialized in KgCommunitySummaryV itself via a
//     LEFT JOIN Missions on communityFingerprint (#986). Previously a
//     virtual populated by an after('READ') handler, but that filter
//     landed at the DB layer over NULL and dropped every row — see #985
//     and #986 for the Louvain-ID-volatility + virtual-column-filter fix.
//
// The tile is @readonly by construction (projection-only); the only
// mutation surface is the promoteCommunityToMission action, which is
// wired as a manifest custom action in kgCommunities/webapp/manifest.json
// (not an annotation-driven UI.Identification — see #1172).
//
// alreadyPromoted default filter: SelectionPresentationVariant #default
// excludes rows where alreadyPromoted=true so curators see only the
// still-actionable communities. Precedent: TaskRecords SUPERSEDED
// exclusion at line 1320 above.
annotate AdminService.KgCommunities with {
  communityId          @Common.Label: 'Community ID';
  memberCount          @Common.Label: 'Members';
  tutorialCount        @Common.Label: 'Tutorials';
  topConceptSlugs      @Common.Label: 'Top Concepts';
  detectedAt           @Common.Label: 'Detected At';
  alreadyPromoted      @Common.Label: 'Already Promoted';
  // #1172 — curator-assist nudges.
  missionCoveragePct   @Common.Label: 'Mission Coverage %';
  dominantMissionTitle @Common.Label: 'Dominant Mission';
  orphanTutorialCount  @Common.Label: 'Orphaned Tutorials';
};

annotate AdminService.KgCommunities with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'Community',
      TypeNamePlural : 'Communities',
      Title          : { Value: communityId },
      Description    : { Value: topConceptSlugs }
    },
    SelectionFields : [ memberCount, detectedAt, alreadyPromoted, missionCoveragePct, orphanTutorialCount ],
    LineItem : [
      { Value: communityId },
      { Value: memberCount },
      { Value: tutorialCount },
      { Value: topConceptSlugs },
      // #1172 coverage nudge columns.
      {
        $Type: 'UI.DataField',
        Value: missionCoveragePct,
        Criticality: { $edmJson: { $If: [ { $Path: 'coverageHigh' }, 1, 3 ] } }
      },
      { Value: dominantMissionTitle },
      { Value: orphanTutorialCount },
      { Value: detectedAt },
      { Value: alreadyPromoted }
    ],
    // Default sort memberCount desc — largest communities first.
    PresentationVariant : {
      SortOrder     : [ { Property: memberCount, Descending: true } ],
      Visualizations: [ '@UI.LineItem' ]
    },
    // Hide already-promoted rows by default. Curators can flip the
    // alreadyPromoted filter in the filter bar to see the full set.
    SelectionPresentationVariant #default : {
      $Type: 'UI.SelectionPresentationVariantType',
      Text : 'Not yet promoted',
      SelectionVariant : {
        $Type: 'UI.SelectionVariantType',
        SelectOptions : [{
          $Type: 'UI.SelectOptionType',
          PropertyName : alreadyPromoted,
          Ranges : [{
            $Type: 'UI.SelectionRangeType',
            Sign  : #E,        // EXCLUDE
            Option: #EQ,
            Low   : true
          }]
        }]
      },
      PresentationVariant : { Visualizations: [ '@UI.LineItem' ] }
    },
    Facets : [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Community' }
    ],
    FieldGroup #General : { Data : [
      { Value: communityId },
      { Value: memberCount },
      { Value: tutorialCount },
      { Value: topConceptSlugs },
      {
        $Type: 'UI.DataField',
        Value: missionCoveragePct,
        Criticality: { $edmJson: { $If: [ { $Path: 'coverageHigh' }, 1, 3 ] } }
      },
      { Value: dominantMissionTitle },
      { Value: orphanTutorialCount },
      { Value: detectedAt },
      { Value: alreadyPromoted }
    ]},
    // The promoteCommunityToMission button was previously rendered here via
    // UI.Identification DataFieldForAction. As of #1172 it is a manifest
    // custom action (controlConfiguration in kgCommunities/webapp/manifest.json)
    // wired to KgCommunityActionsController.onPromoteToMission, which interposes
    // a high-coverage warning dialog before invoking the action. Removing the
    // annotation-driven entry avoids a duplicate button in the OP header.
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// Membership rows — currently referenced only via the promote handler's
// SELECT; no navigation is exposed from KgCommunities. Left annotated
// so admins can inspect memberships directly via the OData surface if
// needed (e.g. debug via URL). No LR tile is wired for this entity.
annotate AdminService.KgCommunityMembers with {
  communityId @Common.Label: 'Community ID';
  vertexKey   @Common.Label: 'Vertex Key';
  vertexType  @Common.Label: 'Vertex Type';
  slug        @Common.Label: 'Slug';
  detectedAt  @Common.Label: 'Detected At';
};

annotate AdminService.KgCommunityMembers with @(
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// ── KG On-Demand Requests (#948) ─────────────────────────────────────────────
// Read-only admin surface for the on-demand extraction queue. Operators
// observe request lifecycle (PENDING → RUNNING → DONE / FAILED) and
// extraction outcomes (tutorialsExtracted, conceptsCreated, latencyMs).
// All mutations come from the drain job (srv/jobs/kg-ondemand-job.js).

annotate AdminService.KgOnDemandRequests with {
  query               @Common.Label: 'Query';
  normalizedKey       @Common.Label: 'Normalized Key';
  status              @Common.Label: 'Status';
  requestedBy         @Common.Label: 'Requested By';
  requestedByKind     @Common.Label: 'Requester Kind';
  attempts            @Common.Label: 'Attempts';
  requestedAt         @Common.Label: 'Requested At';
  startedAt           @Common.Label: 'Started At';
  completedAt         @Common.Label: 'Completed At';
  latencyMs           @Common.Label: 'Latency (ms)';
  tutorialsExtracted  @Common.Label: 'Tutorials Extracted';
  conceptsCreated     @Common.Label: 'Concepts Created';
  conceptsMerged      @Common.Label: 'Concepts Merged';
  lastError           @Common.Label: 'Last Error';
  llmPromptTokens     @Common.Label: 'LLM Prompt Tokens';
  llmCompletionTokens @Common.Label: 'LLM Completion Tokens';
};

annotate AdminService.KgOnDemandRequests with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'KG On-Demand Request',
      TypeNamePlural : 'KG On-Demand Requests',
      Title          : { Value: query },
      Description    : { Value: status }
    },
    SelectionFields : [ status, requestedByKind, requestedAt ],
    LineItem : [
      { Value: query,              Label: 'Query' },
      { Value: normalizedKey,      Label: 'Normalized' },
      { Value: status,             Label: 'Status' },
      { Value: requestedByKind,    Label: 'Requester' },
      { Value: attempts,           Label: 'Attempts' },
      { Value: tutorialsExtracted, Label: 'Tutorials' },
      { Value: conceptsCreated,    Label: 'Created' },
      { Value: conceptsMerged,     Label: 'Merged' },
      { Value: latencyMs,          Label: 'Latency (ms)' },
      { Value: requestedAt,        Label: 'Requested' },
      { Value: completedAt,        Label: 'Completed' },
      { Value: lastError,          Label: 'Last Error' }
    ],
    PresentationVariant : {
      SortOrder     : [ { Property: requestedAt, Descending: true } ],
      Visualizations: [ '@UI.LineItem' ]
    },
    Facets : [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Request',   Label: 'Request' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Extraction', Label: 'Extraction Result' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Cost',       Label: 'Cost' }
    ],
    FieldGroup #Request : { Data : [
      { Value: query },
      { Value: normalizedKey },
      { Value: requestedBy },
      { Value: requestedByKind },
      { Value: requestedAt },
      { Value: status },
      { Value: attempts },
      { Value: lastError }
    ]},
    FieldGroup #Extraction : { Data : [
      { Value: startedAt },
      { Value: completedAt },
      { Value: latencyMs },
      { Value: tutorialsExtracted },
      { Value: conceptsCreated },
      { Value: conceptsMerged }
    ]},
    FieldGroup #Cost : { Data : [
      { Value: llmPromptTokens },
      { Value: llmCompletionTokens }
    ]}
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// --- HomepageFeaturedTopics / FeaturedTopics (#1032) ---
// Editorial overrides for the homepage featured missions carousel.
// Each row pins one concept to a carousel slot with optional display-title
// and mission-slug overrides. The snapshot (FeaturedTopicsSnapshot) is
// materialised by recomputeSnapshot and read by the homepage feed endpoint.
//
// @UI.RecommendationState: 0 on the concept field is required to suppress
// the @cap-js/ai RPT-1 hook that fires on every draft Create — the AICore
// service kind is not resolved in DEV, causing a 500 on first-save.
// Precedent: HomepageForYouCandidatesAdmin.personaTags (line ~3193).

annotate AdminService.FeaturedTopics with @(
  UI.HeaderInfo: {
    TypeName: 'Featured Topic',
    TypeNamePlural: 'Featured Topics',
    Title: { Value: displayTitle }
  },
  UI.LineItem: [
    { Value: concept_ID,    Label: 'Concept' },
    { Value: displayTitle,  Label: 'Display Title' },
    { Value: sortOrder,     Label: 'Order' },
    { Value: validFrom,     Label: 'From' },
    { Value: validUntil,    Label: 'Until' },
    { Value: isActive,      Label: 'Active' },
  ],
  UI.SelectionFields: [ isActive ],
  UI.FieldGroup #Main: { Data: [
    { Value: concept_ID },
    { Value: displayTitle },
    { Value: sortOrder },
    { Value: validFrom },
    { Value: validUntil },
    { Value: isActive },
    { Value: missionSlugs, Label: 'Mission Slug Overrides' },
    { Value: notes },
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Main', Label: 'Details' },
  ],
);

annotate AdminService.FeaturedTopics with {
  concept @(
    // (#1032) Escape hatch: suppress the @cap-js/ai RPT-1 recommendation
    // hook so a draft Create does not crash with "No service definition
    // found for 'AICore'" on CF DEV. See memory cap-ai-plugin-aicore-kind-resolution.
    UI.RecommendationState: 0,
    Common.ValueList: {
      CollectionPath: 'Concepts',
      SearchSupported: true,
      Parameters: [
        { $Type: 'Common.ValueListParameterInOut',
          LocalDataProperty: concept_ID, ValueListProperty: 'ID' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
        { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
      ],
    },
  );
};

annotate AdminService.FeaturedTopicsSnapshotView with @(
  UI.HeaderInfo: {
    TypeName: 'Snapshot Slot',
    TypeNamePlural: 'Snapshot Slots'
  },
  UI.LineItem: [
    { Value: slotOrder },
    { Value: source },
    { Value: conceptSlug },
    { Value: displayTitle },
    { Value: computedAt },
  ],
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// --- (#1031) Videos + HomepageVideoRotation admin surfaces ---
// Videos: single-column editability (excludeFromHomepage) with statistics
// columns visible read-only. Toolbar surfaces recomputeHomepageVideoRotation
// (SuperAdmin-gated by the CDS annotation on the action itself).

annotate AdminService.Videos with @(
  UI.HeaderInfo: {
    TypeName: 'Video',
    TypeNamePlural: 'Videos',
    Title: { Value: title }
  },
  UI.LineItem: [
    { Value: title,               Label: 'Title' },
    { Value: channelTitle,        Label: 'Channel' },
    { Value: publishedAt,         Label: 'Published' },
    { Value: viewCount,           Label: 'Views' },
    { Value: likeCount,           Label: 'Likes' },
    { Value: excludeFromHomepage, Label: 'Excluded' },
    { $Type: 'UI.DataFieldForAction',
      Action: 'AdminService.recomputeHomepageVideoRotation',
      Label: 'Recompute rotation' },
  ],
  UI.SelectionFields: [ excludeFromHomepage ],
  UI.FieldGroup #Main: { Data: [
    { Value: title,               Label: 'Title' },
    { Value: channelTitle,        Label: 'Channel' },
    { Value: publishedAt,         Label: 'Published' },
    { Value: viewCount,           Label: 'View count' },
    { Value: likeCount,           Label: 'Like count' },
    { Value: commentCount,        Label: 'Comment count' },
    { Value: statsLastFetchedAt,  Label: 'Stats last refreshed' },
    { Value: excludeFromHomepage, Label: 'Exclude from homepage' },
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Main', Label: 'Details' },
  ],
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable : false
);

annotate AdminService.Videos with {
  title              @Common.FieldControl: #ReadOnly;
  channelTitle       @Common.FieldControl: #ReadOnly;
  publishedAt        @Common.FieldControl: #ReadOnly;
  viewCount          @Common.FieldControl: #ReadOnly;
  likeCount          @Common.FieldControl: #ReadOnly;
  commentCount       @Common.FieldControl: #ReadOnly;
  statsLastFetchedAt @Common.FieldControl: #ReadOnly;
};

annotate AdminService.HomepageVideoRotationView with @(
  UI.HeaderInfo: {
    TypeName: 'Rotation slot',
    TypeNamePlural: 'Rotation slots'
  },
  UI.LineItem: [
    { Value: rank,     Label: 'Rank' },
    { Value: video_ID, Label: 'Video' },
    { Value: pickedAt, Label: 'Picked at' },
  ],
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// --- Personal Access Tokens (#1105, #1132) ---
// List Report + Object Page over PatService.MyPATs.
// The dataSource for this FE app is /pats/ (PatService), NOT /admin/
// (AdminService). Annotations reference PatService directly.
//
// #1132: revokePAT is now a BOUND action on MyPATs, exposed here as a
// line-item DataFieldForAction (confirmation via @Common.IsActionCritical
// on the CDS action). mintPAT stays an unbound service-level action wired as
// a List Report toolbar button through a controller extension
// (app/admin/pats/webapp/ext/PatActionsController) — mirrors the categories
// admin app's toolbar-action pattern.
//
// `statusCriticality` + `statusText` are virtual fields populated by the
// after('READ') hook in srv/pat-service.js (mirrors the secrets `hasValue`
// pattern) so the list shows a red "Revoked" / green "Active" badge.
// `revocable` gates the revoke button off already-revoked rows.
using PatService from '../srv/pat-service';

annotate PatService.MyPATs with @(
  UI.HeaderInfo: {
    TypeName: 'Personal Access Token',
    TypeNamePlural: 'Personal Access Tokens',
    Title: { Value: name },
    Description: { Value: prefix }
  },
  UI.SelectionFields: [ name, revokedAt ],
  UI.LineItem: [
    { $Type: 'UI.DataFieldForAction',
      Action: 'PatService.revokePAT',
      Label: 'Revoke',
      ![@UI.Importance]: #High },
    { Value: name,        Label: 'Name' },
    { Value: prefix,      Label: 'Prefix' },
    { Value: scopes,      Label: 'Scopes' },
    { Value: statusText,  Label: 'Status', Criticality: statusCriticality },
    { Value: createdAt,   Label: 'Created' },
    { Value: expiresAt,   Label: 'Expires' },
    { Value: lastUsedAt,  Label: 'Last Used' },
    { Value: revokedAt,   Label: 'Revoked' }
  ],
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'DetailsFacet', Label: 'Details',
      Target: '@UI.FieldGroup#Details' }
  ],
  UI.FieldGroup #Details: {
    Data: [
      { Value: name },
      { Value: prefix },
      { Value: scopes },
      { Value: statusText, Label: 'Status', Criticality: statusCriticality },
      { Value: createdAt },
      { Value: expiresAt },
      { Value: lastUsedAt },
      { Value: revokedAt },
      { Value: createdFromIP, Label: 'Created From IP' }
    ]
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// #1132: hide the Revoke button on already-revoked rows. `revocable` is a
// virtual boolean set by the after('READ') hook (true when revokedAt is null).
annotate PatService.MyPATs actions {
  revokePAT @( Core.OperationAvailable: revocable );
};

annotate AdminService.FeatureFlags with @UI: {
  HeaderInfo: {
    TypeName: 'Feature Flag', TypeNamePlural: 'Feature Flags',
    Title: { Value: label },
    Description: { Value: key }
  },
  SelectionFields: [ category, enabled, status, kind ],
  LineItem: [
    { Value: label },
    { Value: category },
    {
      $Type: 'UI.DataField', Value: enabled, Label: 'State',
      Criticality: { $edmJson: { $If: [ { $Path: 'enabled' }, 3, 1 ] } }
    },
    { Value: effectiveValue, Label: 'Effective' },
    { Value: winningLayer, Label: 'Source' },
    { Value: status },
    { Value: issue },
    // #2060 — row-button toggles for kind:'db' flags (non-db flags reject 400).
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.enable',  Label: 'Enable' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.disable', Label: 'Disable' }
  ],
  // Object Page header actions — same enable/disable on the detail view (#2060).
  Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.enable',  Label: 'Enable' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.disable', Label: 'Disable' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General', Label: 'General', Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Resolution', Label: 'Resolution', Target: '@UI.FieldGroup#Resolution' },
    { $Type: 'UI.ReferenceFacet', ID: 'HowTo', Label: 'How to change', Target: '@UI.FieldGroup#HowTo' }
  ],
  FieldGroup#General: { Data: [
    { Value: key }, { Value: label }, { Value: category },
    { Value: kind }, { Value: valueType }, { Value: status }, { Value: issue },
    { Value: description }
  ]},
  FieldGroup#Resolution: { Data: [
    {
      $Type: 'UI.DataField', Value: enabled, Label: 'State',
      Criticality: { $edmJson: { $If: [ { $Path: 'enabled' }, 3, 1 ] } }
    },
    { Value: effectiveValue, Label: 'Effective value' },
    { Value: winningLayer, Label: 'Winning layer' },
    { Value: rawDbValue, Label: 'Raw DB value' },
    { Value: rawEnvValue, Label: 'Raw env value' },
    { Value: defaultValue, Label: 'Default value' }
  ]},
  FieldGroup#HowTo: { Data: [
    { Value: howToChangeText, Label: 'How to change' }
  ]}
};

// --- Petoberfest admin moderation surface ---
// PetSubmissions: moderation queue list report with approve/hide actions.
// Blob columns (photoDisplay/photoThumb) are NOT exposed here; thumbnails are
// served via the express route /admin/petoberfest/photo/:id?size=thumb.
// UI.DataFieldForAction is required for action buttons in the LR toolbar —
// manifest controlConfiguration.actions entries alone render nothing.
annotate AdminService.PetSubmissions with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: petName,      Label: 'Pet Name' },
    { $Type: 'UI.DataField', Value: uploaderName, Label: 'Uploader' },
    { $Type: 'UI.DataField', Value: contestTitle, Label: 'Contest' },
    { $Type: 'UI.DataField', Value: moderation,   Label: 'Status' },
    { $Type: 'UI.DataField', Value: uploadedAt,   Label: 'Uploaded' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.approve', Label: 'Approve' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.hide',    Label: 'Hide' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.purge',   Label: 'Delete' }
  ],
  UI.SelectionFields: [ moderation, contestSlug ],
  UI.HeaderInfo: {
    TypeName: 'Submission',
    TypeNamePlural: 'Submissions',
    Title:    { Value: petName },
    Description: { Value: uploaderName }
  },
  UI.FieldGroup#Details: { Data: [
    { Value: petName,      Label: 'Pet Name' },
    { Value: uploaderName, Label: 'Uploader' },
    { Value: contestTitle, Label: 'Contest' },
    { Value: contestSlug,  Label: 'Contest Slug' },
    { Value: moderation,   Label: 'Status' },
    { Value: sizeBytes,    Label: 'File Size (bytes)' },
    { Value: uploadedAt,   Label: 'Uploaded At' }
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Details', Target: '@UI.FieldGroup#Details' }
  ],
  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.approve', Label: 'Approve' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.hide',    Label: 'Hide' },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.purge',   Label: 'Delete' }
  ],
  Capabilities.DeleteRestrictions: { Deletable: false },
  Capabilities.InsertRestrictions: { Insertable: false },
  Capabilities.UpdateRestrictions: { Updatable: false }
);

annotate AdminService.PetSubmissions with {
  ID           @Common.Label: 'ID';
  petName      @Common.Label: 'Pet Name';
  uploaderName @Common.Label: 'Uploader';
  moderation   @Common.Label: 'Status';
  sizeBytes    @Common.Label: 'Size (bytes)';
  uploadedAt   @Common.Label: 'Uploaded At';
  contestSlug  @Common.Label: 'Contest Slug';
  contestTitle @Common.Label: 'Contest Title';
};

// Petoberfests: contest event metadata (draft-enabled CRUD).
annotate AdminService.Petoberfests with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: title,  Label: 'Title' },
    { $Type: 'UI.DataField', Value: slug,   Label: 'Slug' },
    { $Type: 'UI.DataField', Value: status, Label: 'Status' }
  ],
  UI.SelectionFields: [ status ],
  UI.HeaderInfo: {
    TypeName: 'Petoberfest',
    TypeNamePlural: 'Petoberfests',
    Title:    { Value: title },
    Description: { Value: slug }
  },
  UI.FieldGroup#General: { Data: [
    { Value: title,  Label: 'Title' },
    { Value: slug,   Label: 'Slug' },
    { Value: status, Label: 'Status' },
    { Value: intro,  Label: 'Introduction (Markdown)' }
  ]},
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'General', Target: '@UI.FieldGroup#General' }
  ]
);

// intro is author-facing solving/instruction text rendered as Markdown on the
// public page (issue #1911). @UI.MultiLineText makes the Object Page field a
// multi-line text area instead of a single-line input, so authors can write a
// short paragraph with a link.
annotate AdminService.Petoberfests with {
  intro @UI.MultiLineText @Common.Label: 'Introduction (Markdown)';
};

// --- Topic Clusters (#topics-discovery) ---
// LR/OP annotations for the topic-cluster curation tile.
// TopicClustersAdmin is @readonly by construction (projection-only); the only
// mutation surfaces are overrideTopicLabel and setTopicClusterHidden, wired as
// manifest custom actions (controlConfiguration in
// topicClusters/webapp/manifest.json — not annotation-driven DataFieldForAction).
//
// #986 gotcha: do NOT add a default SelectionPresentationVariant filter over
// the VIRTUAL `effectiveLabel` column — virtual columns cannot be used in a
// default LR filter because HANA has no DB column to filter. Default filter on
// the real `status` column is safe.
annotate AdminService.TopicClustersAdmin with {
  slug          @Common.Label: 'Slug';
  label         @Common.Label: 'Computed Label';
  curatedLabel  @Common.Label: 'Curated Label';
  effectiveLabel @Common.Label: 'Effective Label';
  rationale     @Common.Label: 'Rationale';
  status        @Common.Label: 'Status';
  hidden        @Common.Label: 'Hidden';
  memberCount   @Common.Label: 'Members';
  tutorialCount @Common.Label: 'Tutorials';
  computedAt    @Common.Label: 'Computed At';
};

annotate AdminService.TopicClustersAdmin with @(
  UI: {
    HeaderInfo: {
      TypeName       : 'Topic Cluster',
      TypeNamePlural : 'Topic Clusters',
      Title          : { Value: effectiveLabel },
      Description    : { Value: slug }
    },
    SelectionFields : [ status, hidden, tutorialCount ],
    LineItem : [
      { Value: effectiveLabel },
      { Value: tutorialCount },
      { Value: memberCount },
      { Value: status },
      { Value: hidden }
    ],
    // Default sort tutorialCount desc — largest clusters first.
    PresentationVariant : {
      SortOrder     : [ { Property: tutorialCount, Descending: true } ],
      Visualizations: [ '@UI.LineItem' ]
    },
    // Default filter: show only ACTIVE clusters (status is a real DB column, safe
    // to use as a default filter — see #986 gotcha re: virtual effectiveLabel).
    SelectionPresentationVariant #default : {
      $Type: 'UI.SelectionPresentationVariantType',
      Text : 'Active clusters',
      SelectionVariant : {
        $Type: 'UI.SelectionVariantType',
        SelectOptions : [{
          $Type: 'UI.SelectOptionType',
          PropertyName : status,
          Ranges : [{
            $Type: 'UI.SelectionRangeType',
            Sign  : #I,       // INCLUDE
            Option: #EQ,
            Low   : 'ACTIVE'
          }]
        }]
      },
      PresentationVariant : { Visualizations: [ '@UI.LineItem' ] }
    },
    Facets : [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Topic Cluster' }
    ],
    FieldGroup #General : { Data : [
      { Value: slug },
      { Value: effectiveLabel },
      { Value: label },
      { Value: curatedLabel },
      { Value: rationale },
      { Value: status },
      { Value: hidden },
      { Value: tutorialCount },
      { Value: memberCount },
      { Value: computedAt }
    ]},
    // The overrideTopicLabel and setTopicClusterHidden buttons are manifest
    // custom actions (controlConfiguration in topicClusters/webapp/manifest.json)
    // wired to TopicClusterActionsController. No annotation-driven
    // DataFieldForAction is used (avoids duplicate buttons in OP header).
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable : false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// --- Tutorial Freshness Detector (spec 2026-08-22-tutorial-freshness-detector) ---
// Surfaces per-finding analysis rows on the Tutorials Object Page and wires the
// Freshness Reports — report-level header (spec 2026-08-31 task-5).
// PresentationVariant sorts newest-first so the latest run appears at the top.
annotate AdminService.FreshnessReport with @(
  UI.LineItem: [
    { Value: runAt,         Label: 'Run At' },
    { Value: status,        Label: 'Status' },
    { Value: model,         Label: 'Model' },
    { Value: cost,          Label: 'Cost' },
    { Value: openHighCount, Label: 'Open High' },
    { Value: error,         Label: 'Error' }
  ],
  UI.PresentationVariant: { SortOrder: [{ Property: runAt, Descending: true }], Visualizations: ['@UI.LineItem'] }
);

// Set Disposition action. Criticality paths delegate to the virtual
// `confidenceCriticality` field (computed by after('READ','FreshnessFinding')
// in admin-service.js).
annotate AdminService.FreshnessFinding with @UI: {
  LineItem: [
    { Value: confidence, Criticality: confidenceCriticality, ![@UI.Importance]: #High },
    { Value: severity },
    { Value: category },
    { Value: stepRef, Label: 'Step' },
    { Value: codeBlockIndex, Label: 'Block' },
    { Value: summary },
    { Value: suggestedFix },
    { Value: groundingSource, Label: 'Source' },
    { Value: disposition, Criticality: confidenceCriticality },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.setDisposition', Label: 'Set disposition' }
  ],
  PresentationVariant: {
    // Sort on the persisted numeric ranks (High=3..Low=1) so High-confidence
    // findings sort FIRST. A descending sort on the confidence/severity STRING
    // columns is OData-lexical (High < Low < Medium), which sorts High last.
    SortOrder: [
      { Property: confidenceRank, Descending: true },
      { Property: severityRank,   Descending: true }
    ]
  }
};
annotate AdminService.FreshnessFinding with {
  suggestedFix @UI.MultiLineText;
  evidence     @UI.MultiLineText;
};

// --- Media facets: TutorialImages + TutorialAssets (Task 4) ---
annotate AdminService.TutorialImages with @(
  UI.LineItem: [
    { $Type: 'UI.DataFieldWithUrl', Value: sourceUrl, Url: sourceUrl, Label: 'Source (GitHub)' },
    { Value: mimeType,    Label: 'Type' },
    { Value: byteSize,    Label: 'Bytes' },
    { Value: contentHash, Label: 'Hash' },
    { Value: channel,     Label: 'Channel' }
  ]
);
annotate AdminService.TutorialAssets with @(
  UI.LineItem: [
    { Value: filename,    Label: 'File' },
    { $Type: 'UI.DataFieldWithUrl', Value: sourceUrl, Url: sourceUrl, Label: 'Source (GitHub)' },
    { Value: mimeType,    Label: 'Type' },
    { Value: byteSize,    Label: 'Bytes' },
    { Value: contentHash, Label: 'Hash' }
  ]
);
