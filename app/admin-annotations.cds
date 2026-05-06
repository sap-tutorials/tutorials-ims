// app/admin-annotations.cds
using AdminService from '../srv/admin-service';

// --- Draft Enablement ---
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;

// --- Events ---
annotate AdminService.Events with {
  legacyId  @Common.Label: 'Event ID';
  name      @Common.Label: 'Name';
  startDate @Common.Label: 'Start Date';
  endDate   @Common.Label: 'End Date';
  timeZone  @Common.Label: 'Time Zone';
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
    { $Type: 'UI.ReferenceFacet', Target: 'prizes/@UI.LineItem', Label: 'Prizes' },
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
annotate AdminService.Missions with {
  legacyId           @Common.Label: 'Mission ID';
  title              @Common.Label: 'Title';
  description        @Common.Label: 'Description';
  slug               @Common.Label: 'Slug';
  communityMissionId @Common.Label: 'Community Mission ID';
  experienceTag      @Common.Label: 'Experience'  @Common.ValueListWithFixedValues;
  primaryTag         @Common.Label: 'Primary Tag (text)';
  primaryTagRef_ID   @Common.Label: 'Primary Tag';
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
    { $Type: 'UI.ReferenceFacet', Target: 'completionPaths/@UI.LineItem', Label: 'Completion Paths' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: slug },
    { Value: description },
    { Value: communityMissionId },
    { Value: experienceTag },
    { Value: primaryTagRef_ID },
    { Value: published, @UI.FieldControl: publishedFieldControl },
    { Value: status },
    { Value: averageTimeToComplete }
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
annotate AdminService.CompletionPaths with {
  name @Common.Label: 'Path Name';
  slug @Common.Label: 'Slug';
};

annotate AdminService.CompletionPaths with @UI: {
  LineItem: [
    { Value: name },
    { Value: slug }
  ]
};

annotate AdminService.CompletionPathItems with {
  taskLegacyId @Common.Label: 'Task ID';
  taskType     @Common.Label: 'Type'  @Common.ValueListWithFixedValues;
  itemOrder    @Common.Label: 'Order';
};

annotate AdminService.CompletionPathItems with @UI: {
  LineItem: [
    { Value: taskLegacyId },
    { Value: taskType },
    { Value: itemOrder }
  ]
};

// --- Groups ---
annotate AdminService.Groups with {
  legacyId              @Common.Label: 'Group ID';
  title                 @Common.Label: 'Title';
  description           @Common.Label: 'Description';
  experienceTag         @Common.Label: 'Experience'  @Common.ValueListWithFixedValues;
  primaryTag            @Common.Label: 'Primary Tag (text)';
  primaryTagRef_ID      @Common.Label: 'Primary Tag';
  averageTimeToComplete @Common.Label: 'Avg Time (min)';
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
    { $Type: 'UI.ReferenceFacet', Target: 'missions/@UI.LineItem', Label: 'Missions' },
    { $Type: 'UI.ReferenceFacet', Target: 'changes/@UI.PresentationVariant', Label: 'Change History', ![@UI.PartOfPreview]: false }
  ],
  FieldGroup#General: { Data: [
    { Value: title },
    { Value: description },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: primaryTagRef_ID },
    { Value: published, @UI.FieldControl: publishedFieldControl },
    { Value: status }
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
annotate AdminService.Accomplishments with {
  legacyId    @Common.Label: 'ID';
  name        @Common.Label: 'Name';
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
  legacyId @Common.Label: 'ID';
  name     @Common.Label: 'Name';
  event    @Common.Label: 'Event';
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

// --- Tutorials (read-only) ---
annotate AdminService.Tutorials with {
  legacyId              @Common.Label: 'Tutorial ID';
  title                 @Common.Label: 'Title';
  slug                  @Common.Label: 'Slug';
  primaryTag            @Common.Label: 'Primary Tag';
  experienceTag         @Common.Label: 'Experience'  @Common.ValueListWithFixedValues;
  averageTimeToComplete @Common.Label: 'Avg Time (min)';
  status                @Common.Label: 'Status'  @Common.ValueListWithFixedValues;
};

annotate AdminService.Tutorials with @UI: {
  HeaderInfo: {
    TypeName: 'Tutorial', TypeNamePlural: 'Tutorials',
    Title: { Value: title },
    Description: { Value: slug }
  },
  SelectionFields: [ title, primaryTag, experienceTag ],
  LineItem: [
    { Value: legacyId },
    { Value: title },
    { Value: slug },
    { Value: primaryTag },
    { Value: experienceTag },
    { Value: averageTimeToComplete },
    { Value: status }
  ]
};

// --- Tags (read-only) ---
annotate AdminService.Tags with {
  legacyId  @Common.Label: 'ID';
  name      @Common.Label: 'Name';
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
    Sort: [{ Property: startedAt, Descending: true }]
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
  errorDetails  @Common.Label: 'Error';
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
    Sort: [{ Property: startedAt, Descending: true }]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);

// ChangeView UI annotations are provided by @cap-js/change-tracking plugin (index.cds)
// ReadRestrictions override is applied at runtime in srv/admin-service.js

// --- PrimaryAccounts / SecondaryAccounts (read-only) ---
annotate AdminService.PrimaryAccounts with {
  uuid   @Common.Label: 'UUID';
  status @Common.Label: 'Status';
};

annotate AdminService.PrimaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Primary Account', TypeNamePlural: 'Primary Accounts',
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
  uuid              @Common.Label: 'UUID';
  primaryAccount_ID @Common.Label: 'Primary Acct';
  status            @Common.Label: 'Status';
  mergedAt          @Common.Label: 'Merged At';
};

annotate AdminService.SecondaryAccounts with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Secondary Account', TypeNamePlural: 'Secondary Accounts',
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
