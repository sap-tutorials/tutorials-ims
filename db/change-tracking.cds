// Change tracking is configured via @changelog annotations at the service level
// in srv/change-tracking.cds. The @cap-js/change-tracking plugin automatically
// adds the 'changes' association and UI facet to annotated entities at runtime.
//
// Annotating at the service level (AdminService) means only admin UI changes
// are tracked — bulk imports, scheduled jobs, and replication are excluded.

using { com.sap.developers.ims as ims } from './schema';

annotate ims.ChatSettings with @changelog;
annotate ims.Advocates       with @changelog;
annotate ims.AdvocateTopics  with @changelog;
annotate ims.AdvocateLinks   with @changelog;
