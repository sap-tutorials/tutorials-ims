// db/schema-ext.cds
using { com.sap.developers.ims as ims } from './schema';

// Order of missions within their parent group
extend ims.Missions with {
  groupOrder : Integer default 0;
}

// Association-based tag reference for value help support
// (retains existing primaryTag:String for backward compat)
extend ims.TaskBase with {
  primaryTagRef : Association to ims.Tags;
}
