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
