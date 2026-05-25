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
  legacyId  @Common.Label: 'Event ID' @Common.IsDigitSequence: true;
  name      @Common.Label: 'Name'
            // Self-referential value help on the SelectionFields filter so users
            // pick from existing event names instead of typing free-form. The
            // legacyId + startDate display-only columns disambiguate events that
            // share a base name across years (e.g. multiple "TechEd" rows).
            @Common.ValueList: {
              CollectionPath: 'Events',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: name, ValueListProperty: 'name' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' },
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
    { Value: legacyId },
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
  legacyId           @Common.Label: 'Mission ID' @Common.IsDigitSequence: true;
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
    { Value: legacyId },
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
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
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
  itemOrder       @Common.Label: 'Order'  @UI.Hidden;
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
      { Value: prize_ID }
    ]
  },
  PresentationVariant: { SortOrder: [ { Property: itemOrder } ] },
  LineItem: [
    { Value: prize_ID, Label: 'Prize' }
  ]
};


// --- Groups ---
annotate AdminService.Groups with {
  legacyId              @Common.Label: 'Group ID' @Common.IsDigitSequence: true;
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
    { Value: legacyId },
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
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
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
};

annotate AdminService.GroupPathItems with @UI: {
  PresentationVariant: { SortOrder: [ { Property: itemOrder } ] },
  LineItem: [
    { Value: itemOrder },
    { Value: tutorial_ID, Label: 'Tutorial' }
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
  legacyId    @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name        @Common.Label: 'Name'
              @Common.ValueList: {
                CollectionPath: 'Accomplishments',
                Parameters: [
                  { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: name, ValueListProperty: 'name' },
                  { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
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
    { Value: legacyId },
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
  legacyId @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name     @Common.Label: 'Name';
  event    @Common.Label: 'Event'
           @Common.ValueList: {
             CollectionPath: 'Events',
             Parameters: [
               { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: event_ID, ValueListProperty: 'ID' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
               { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' },
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
    { Value: legacyId },
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
  legacyId              @Common.Label: 'Tutorial ID' @Common.FieldControl: #ReadOnly @Common.IsDigitSequence: true;
  title                 @Common.Label: 'Title'       @Common.FieldControl: #ReadOnly
                        @Common.ValueList: {
                          CollectionPath: 'Tutorials',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: title, ValueListProperty: 'title' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'slug' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'primaryTag' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
                          ]
                        };
  slug                  @Common.Label: 'Slug'        @Common.FieldControl: #ReadOnly;
  primaryTag            @Common.Label: 'Primary Tag' @Common.FieldControl: #ReadOnly
                        @Common.ValueList: {
                          CollectionPath: 'Tags',
                          Parameters: [
                            { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: primaryTag, ValueListProperty: 'name' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'titlePath' },
                            { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
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

annotate AdminService.Tutorials with @UI: {
  HeaderInfo: {
    TypeName: 'Tutorial', TypeNamePlural: 'Tutorials',
    Title: { Value: title },
    Description: { Value: slug }
  },
  SelectionFields: [ title, primaryTag, experienceTag, status ],
  LineItem: [
    { Value: legacyId },
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: status },
    { Value: redirectTo.title, Label: 'Redirect To' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'General',  Label: 'General',  Target: '@UI.FieldGroup#General' },
    { $Type: 'UI.ReferenceFacet', ID: 'Lifecycle', Label: 'Lifecycle', Target: '@UI.FieldGroup#Lifecycle' }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete }
  ]},
  FieldGroup#Lifecycle: { Data: [
    { Value: status },
    { Value: deletionReason },
    { Value: redirectTo_ID, Label: 'Redirect To' }
  ]}
};

// --- TutorialPickList (value-help target for redirectTo) ---
annotate AdminService.TutorialPickList with {
  legacyId   @Common.Label: 'Tutorial ID' @Common.IsDigitSequence: true;
  title      @Common.Label: 'Title';
  slug       @Common.Label: 'Slug';
  primaryTag @Common.Label: 'Primary Tag';
};

annotate AdminService.TutorialPickList with @(
  UI: {
    HeaderInfo: { TypeName: 'Tutorial', TypeNamePlural: 'Tutorials', Title: { Value: title } },
    SelectionFields: [ title, primaryTag ],
    LineItem: [
      { Value: legacyId },
      { Value: title },
      { Value: slug },
      { Value: primaryTag }
    ]
  }
);

// --- Tags (read-only) ---
annotate AdminService.Tags with {
  legacyId  @Common.Label: 'ID' @Common.IsDigitSequence: true;
  name      @Common.Label: 'Name'
            @Common.ValueList: {
              CollectionPath: 'Tags',
              Parameters: [
                { $Type: 'Common.ValueListParameterInOut',       LocalDataProperty: name, ValueListProperty: 'name' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'titlePath' },
                { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'legacyId' }
              ]
            };
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
      { Value: legacyId },
      { Value: name },
      { Value: mdFormat },
      { Value: titlePath }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- FeaturedTasks (inline editing of featuredOrder) ---
annotate AdminService.FeaturedTasks with {
  taskLegacyId  @Common.Label: 'Task ID';
  taskType      @Common.Label: 'Type'  @Common.ValueListWithFixedValues;
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
  pipelineType  @Common.Label: 'Type'  @Common.ValueListWithFixedValues;
  status        @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
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
      { $Type: 'UI.DataFieldWithUrl', Label: 'CF Logs', Value: cfLogsUrl, Url: cfLogsUrl }
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
  status        @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
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
      { $Type: 'UI.DataFieldWithUrl', Label: 'CF Logs', Value: cfLogsUrl, Url: cfLogsUrl }
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
  status @Common.Label: 'Status';
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
  primaryAccount_ID @Common.Label: 'Merged Into';
  status            @Common.Label: 'Status';
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
      { Value: primaryAccount_ID },
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
  Analytics.AggregatedProperties: [{
    Name: 'totalCompletions',
    AggregationMethod: 'sum',
    AggregatableProperty: completionCount,
    ![@Common.Label]: 'Completions'
  }],
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
