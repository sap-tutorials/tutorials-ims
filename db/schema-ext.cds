// db/schema-ext.cds
using { com.sap.developers.ims as ims } from './schema';

// Order of missions within their parent group
extend ims.Missions with {
  groupOrder : Integer default 0;
}

// Association-based tag reference for value help support
extend ims.TaskBase with {
  primaryTagRef : Association to ims.Tags;
}

// Analytics Explorer — exposed view/entity allowlist.
// Two-place change to add a new exposed entity: this annotation +
// a corresponding @readonly projection in srv/analytics-service.cds.

annotate ims.Tasks                  with @analytics : { exposed: true, label: 'Tasks (denormalized)' };
annotate ims.NavigatorCatalog       with @analytics : { exposed: true, label: 'Navigator catalog' };
annotate ims.SearchableItems        with @analytics : { exposed: true, label: 'Searchable items' };
annotate ims.CompletionAnalytics    with @analytics : { exposed: true, label: 'Completion analytics' };
annotate ims.TaskRecords            with @analytics : { exposed: true, label: 'Task records' };
annotate ims.Users                  with @analytics : { exposed: true, label: 'Users' };
annotate ims.Missions               with @analytics : { exposed: true, label: 'Missions' };
annotate ims.Groups                 with @analytics : { exposed: true, label: 'Groups' };
annotate ims.Tutorials              with @analytics : { exposed: true, label: 'Tutorials' };
annotate ims.Events                 with @analytics : { exposed: true, label: 'Events' };
annotate ims.PrizeRecords           with @analytics : { exposed: true, label: 'Prize records' };
annotate ims.AccomplishmentRecords  with @analytics : { exposed: true, label: 'Accomplishment records' };
