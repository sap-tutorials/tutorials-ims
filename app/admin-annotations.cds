// app/admin-annotations.cds
using AdminService from '../srv/admin-service';

// --- Draft Enablement ---
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;

// --- Events ---
annotate AdminService.Events with @UI: {
  HeaderInfo: {
    TypeName: 'Event', TypeNamePlural: 'Events',
    Title: { Value: name },
    Description: { Value: timeZone }
  },
  SelectionFields: [ name, startDate, endDate ],
  LineItem: [
    { Value: legacyId, Label: 'Event ID' },
    { Value: name, Label: 'Name' },
    { Value: startDate, Label: 'Start Date' },
    { Value: endDate, Label: 'End Date' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General Information' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: startDate },
    { Value: endDate },
    { Value: timeZone }
  ]}
};

// --- Missions ---
annotate AdminService.Missions with @UI: {
  HeaderInfo: {
    TypeName: 'Mission', TypeNamePlural: 'Missions',
    Title: { Value: title },
    Description: { Value: experienceTag }
  },
  SelectionFields: [ title, experienceTag, status ],
  LineItem: [
    { Value: legacyId, Label: 'Mission ID' },
    { Value: title, Label: 'Title' },
    { Value: experienceTag, Label: 'Experience' },
    { Value: primaryTagRef.name, Label: 'Primary Tag' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General' },
    { $Type: 'UI.ReferenceFacet', Target: 'completionPaths/@UI.LineItem', Label: 'Completion Paths' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: description },
    { Value: communityMissionId },
    { Value: experienceTag },
    { Value: primaryTagRef_ID },
    { Value: status }
  ]}
};

annotate AdminService.Missions with {
  primaryTagRef @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: primaryTagRef_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
    ]
  };
};

// CompletionPaths line items
annotate AdminService.CompletionPaths with @UI: {
  LineItem: [
    { Value: name, Label: 'Path Name' },
    { Value: slug, Label: 'Slug' }
  ]
};

annotate AdminService.CompletionPathItems with @UI: {
  LineItem: [
    { Value: taskLegacyId, Label: 'Task ID' },
    { Value: taskType, Label: 'Type' },
    { Value: itemOrder, Label: 'Order' }
  ]
};

// --- Groups ---
annotate AdminService.Groups with @UI: {
  HeaderInfo: {
    TypeName: 'Group', TypeNamePlural: 'Groups',
    Title: { Value: title },
    Description: { Value: experienceTag }
  },
  SelectionFields: [ title, experienceTag ],
  LineItem: [
    { Value: legacyId, Label: 'Group ID' },
    { Value: title, Label: 'Title' },
    { Value: averageTimeToComplete, Label: 'Avg Time' },
    { Value: experienceTag, Label: 'Experience' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'General' },
    { $Type: 'UI.ReferenceFacet', Target: 'missions/@UI.LineItem', Label: 'Missions' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: description },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: primaryTagRef_ID }
  ]}
};

annotate AdminService.Groups with {
  primaryTagRef @Common.ValueList: {
    CollectionPath: 'Tags',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: primaryTagRef_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
    ]
  };
};

// --- Accomplishments ---
annotate AdminService.Accomplishments with @UI: {
  HeaderInfo: {
    TypeName: 'Accomplishment', TypeNamePlural: 'Accomplishments',
    Title: { Value: name }
  },
  SelectionFields: [ name ],
  LineItem: [
    { Value: legacyId, Label: 'ID' },
    { Value: name, Label: 'Name' },
    { Value: description, Label: 'Description' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Details' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: name },
    { Value: description },
    { Value: rule, Label: 'Rule' }
  ]}
};

annotate AdminService.Accomplishments with {
  rule @UI.MultiLineText;
};

// --- Prizes ---
annotate AdminService.Prizes with @UI: {
  HeaderInfo: {
    TypeName: 'Prize', TypeNamePlural: 'Prizes',
    Title: { Value: name }
  },
  LineItem: [
    { Value: legacyId, Label: 'ID' },
    { Value: name, Label: 'Name' }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Details' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: name }
  ]}
};

// --- Tutorials (read-only) ---
annotate AdminService.Tutorials with @UI: {
  HeaderInfo: {
    TypeName: 'Tutorial', TypeNamePlural: 'Tutorials',
    Title: { Value: title }
  },
  SelectionFields: [ title, primaryTag ],
  LineItem: [
    { Value: title, Label: 'Title' },
    { Value: primaryTag, Label: 'Primary Tag' },
    { Value: experienceTag, Label: 'Experience' },
    { Value: averageTimeToComplete, Label: 'Avg Time' }
  ]
};

// --- Tags (read-only) ---
annotate AdminService.Tags with @UI: {
  HeaderInfo: {
    TypeName: 'Tag', TypeNamePlural: 'Tags',
    Title: { Value: name }
  },
  LineItem: [
    { Value: legacyId, Label: 'ID' },
    { Value: name, Label: 'Name' }
  ]
};

// --- FeaturedTasks (inline editing of featuredOrder) ---
annotate AdminService.FeaturedTasks with @UI: {
  HeaderInfo: {
    TypeName: 'Featured Task', TypeNamePlural: 'Featured Tasks',
    Title: { Value: taskLegacyId }
  },
  SelectionFields: [ taskType ],
  LineItem: [
    { Value: taskLegacyId, Label: 'Task ID' },
    { Value: taskType, Label: 'Type' },
    { Value: featuredOrder, Label: 'Order', ![@UI.Importance]: #High }
  ]
};

// --- ImsConfig (key/value CRUD) ---
// Note: the schema field is `![key]` (escaped CDS keyword)
annotate AdminService.ImsConfig with @UI: {
  HeaderInfo: {
    TypeName: 'Configuration', TypeNamePlural: 'Configurations',
    Title: { Value: ![key] }
  },
  SelectionFields: [ ![key] ],
  LineItem: [
    { Value: ![key], Label: 'Key' },
    { Value: value, Label: 'Value' }
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
annotate AdminService.StepFailures with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Step Failure', TypeNamePlural: 'Step Failures',
      Title: { Value: stepNumber }
    },
    SelectionFields: [ failureDate ],
    LineItem: [
      { Value: stepNumber, Label: 'Step #' },
      { Value: errorMessage, Label: 'Error' },
      { Value: failureDate, Label: 'Date' }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- NGDSFailedMessages (read-only, retry action per row) ---
annotate AdminService.NGDSFailedMessages with @(
  UI: {
    HeaderInfo: {
      TypeName: 'NGDS Failed Message', TypeNamePlural: 'NGDS Failed Messages',
      Title: { Value: ID }
    },
    SelectionFields: [ status ],
    LineItem: [
      { Value: ID, Label: 'ID' },
      { Value: status, Label: 'Status' },
      { Value: errorMessage, Label: 'Error' },
      { Value: createdAt, Label: 'Failed At' }
    ]
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// --- FailedEmails (read-only, deletable) ---
annotate AdminService.FailedEmails with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Failed Email', TypeNamePlural: 'Failed Emails',
      Title: { Value: subject }
    },
    SelectionFields: [ createdAt ],
    LineItem: [
      { Value: to, Label: 'Recipient' },
      { Value: subject, Label: 'Subject' },
      { Value: createdAt, Label: 'Failed At' }
    ]
  },
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// ChangeView UI annotations are provided by @cap-js/change-tracking plugin (index.cds)

// --- PrimaryAccounts / SecondaryAccounts (read-only) ---
annotate AdminService.PrimaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Primary Account', TypeNamePlural: 'Primary Accounts',
      Title: { Value: uuid }
    },
    SelectionFields: [ uuid, status ],
    LineItem: [
      { Value: uuid, Label: 'UUID' },
      { Value: status, Label: 'Status' }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

annotate AdminService.SecondaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Secondary Account', TypeNamePlural: 'Secondary Accounts',
      Title: { Value: uuid }
    },
    SelectionFields: [ uuid, status ],
    LineItem: [
      { Value: uuid, Label: 'UUID' },
      { Value: primaryAccount_ID, Label: 'Primary Acct' },
      { Value: status, Label: 'Status' },
      { Value: mergedAt, Label: 'Merged At' }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);
