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
  Facets: [{
    $Type: 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#General',
    Label: 'General Information'
  }],
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
    { $Type: 'UI.ReferenceFacet', Target: 'completionPaths/@UI.LineItem', Label: 'Completion Paths' }
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
    { $Type: 'UI.ReferenceFacet', Target: 'missions/@UI.LineItem', Label: 'Missions' }
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
  Facets: [{
    $Type: 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#General',
    Label: 'Details'
  }],
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
  Facets: [{
    $Type: 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#General',
    Label: 'Details'
  }],
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
