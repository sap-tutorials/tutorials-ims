// app/admin-annotations.cds
using AdminService from '../srv/admin-service';

// --- Draft Enablement ---
annotate AdminService.Missions with @odata.draft.enabled;
annotate AdminService.Groups with @odata.draft.enabled;
annotate AdminService.Events with @odata.draft.enabled;
annotate AdminService.Accomplishments with @odata.draft.enabled;
