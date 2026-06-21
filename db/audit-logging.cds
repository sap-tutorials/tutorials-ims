using { com.sap.developers.ims as ims } from './schema';
using from './knowledge-graph';

annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject',
  cascade: 'identity-replace'
} {
  ID          @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid        @PersonalData.IsPotentiallyPersonal;
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
}

annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

// Issue #172 PR 6 — Pilot enablement.
// Mirrors the UserMetaData pattern verbatim. The cascade walker
// (srv/lib/anonymization-cascade.js) is annotation-driven and walks every
// entity with @PersonalData; no allowlist update needed. Hybrid test 3
// verifies cascade-delete in real HANA.
annotate ims.UserLearningPreferences with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'audit-only'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

annotate ims.CodeCheckSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user          @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
}

annotate ims.ValidateAnswerSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
}

annotate ims.AuthorAiRequests with @PersonalData: {
  EntitySemantics: 'Other'
} {
  authorId       @PersonalData.FieldSemantics: 'DataSubjectID';
  sourceMarkdown @PersonalData.IsPotentiallyPersonal;
  variants       @PersonalData.IsPotentiallyPersonal;
}

annotate ims.BranchDecisions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

// Knowledge graph (#381). Concepts is admin-edited (merge / veto / rename) and
// while it carries no personal data, the audit-logging plugin's annotation-driven
// emission gives us a tamper-evident record of curation actions for free —
// mirrors how Categories / Missions admin edits are surfaced.
annotate ims.Concepts with @PersonalData: {
  EntitySemantics: 'Other'
};

// Phase 2-C (#465): security-purpose audit on Secrets metadata writes.
// EntitySemantics: 'Other' is the documented annotation for entities that
// need audit logging but are NOT DataSubjects (DataSubject / DataSubjectDetails
// are for personal-data entities; 'Other' covers everything else). Per CAP
// @PersonalData docs, 'Other' on Secrets registers the entity with the
// @cap-js/audit-logging plugin so CRUD mutations on the standard projection
// (description, expiresAt, rotationOwner changes via the admin tile's
// metadata editor) emit audit events.
//
// The 4 custom OData V4 operations (setSecretValue, rotateSecretValue,
// revealSecretValue, clearSecretValue) do NOT fire these CRUD interceptors
// — their handlers in srv/admin-service.js call audit.log('SecurityEvent',
// { data: { action: 'SecretValueRead', ... } }) explicitly via the
// auditEvent() helper (Task 6). 'SecurityEvent' is the only registered
// event name; custom event names like 'SecretValueRead' are NOT registered
// in the plugin's CDS service definition and would silently drop or throw.
// The action discriminator therefore lives in data.action.
annotate ims.Secrets with @PersonalData: {
  EntitySemantics: 'Other'
} {
  ![key]      @PersonalData.IsPotentiallyPersonal;
  description @PersonalData.IsPotentiallyPersonal;
};
