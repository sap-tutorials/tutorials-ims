using { com.sap.developers.ims as ims } from './schema';
using from './knowledge-graph';

annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject',
  cascade: 'identity-replace'
} {
  ID              @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid            @PersonalData.IsPotentiallyPersonal;
  firstName       @PersonalData.IsPotentiallyPersonal;
  lastName        @PersonalData.IsPotentiallyPersonal;
  email           @PersonalData.IsPotentiallyPersonal;
  displayName     @PersonalData.IsPotentiallyPersonal;
  sapId           @PersonalData.IsPotentiallyPersonal;
  khorosId        @PersonalData.IsPotentiallyPersonal;
  khorosLogin     @PersonalData.IsPotentiallyPersonal;
  khorosAvatarUrl @PersonalData.IsPotentiallyPersonal;
  // khorosLinkedAt — not personal (just a timestamp), no annotation
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

// Concepts audit trail moved to @cds.changelog — see db/change-tracking.cds (#960).

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
//
// IMPORTANT: do NOT add field-level @PersonalData.IsPotentiallyPersonal
// annotations to Secrets fields. Those annotations are only valid on
// DataSubject / DataSubjectDetails entities — the @cap-js/audit-logging
// plugin's addDataSubjectForDetailsEntity() walks the template to find
// the parent DataSubject's identifying field, and crashes when called
// on an 'Other' entity (TypeError: Cannot read properties of undefined
// reading 'dataSubjectEntity'). The crash kills the worker, causing
// HTTP 502 on the very POST that initializes the Secrets row. Caught
// 2026-06-22 on first DEV bootstrap of the Secrets UI; the original
// commit predates that test path. EntitySemantics: 'Other' on its own
// is sufficient to register the entity for CRUD audit-event capture.
annotate ims.Secrets with @PersonalData: {
  EntitySemantics: 'Other'
};

// --- Advocates ↔ Users link (spec 2026-06-25-advocate-user-link-design) ---
//
// Advocates.user_ID is the ONE place in this codebase where we publicly
// expose Users.email (via /api/advocates). Proactively NULL the FK on
// User anonymization so the public endpoint immediately stops emitting
// the (now-anonymized) email — stronger than relying on the email being
// scrubbed to a placeholder.
//
// Intentionally divergent from PR #618 which did NOT annotate
// Tutorials.author / TutorialContributors.user (those FKs are internal
// authorship records, not a public-facing surface).
//
// cascade: 'null-personal' triggers cascadeNullPersonal in
// srv/lib/anonymization-cascade.js → UPDATE Advocates SET user_ID = NULL
// WHERE user_ID = <anonymized-user-id>.
annotate ims.Advocates with @PersonalData: {
  EntitySemantics: 'Other',
  cascade        : 'null-personal'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

// #960 — DataSubjectDetails compositions of ims.Users. The @cap-js/data-privacy
// plugin flags these as missing at boot (modelling bad-practice warning) because
// they compose off Users but carry no personal-data semantics. Adding
// EntitySemantics: 'DataSubjectDetails' + cascade: 'delete' both silences the
// warning AND fixes a latent bug: today these rows survive user anonymization
// as FK-ghosts pointing at anonymized ghost users. Field-level review confirmed
// none carries analytical value post-anonymization (see spec §2a).
annotate ims.PrizeRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.AccomplishmentRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

annotate ims.DeveloperEnvironmentTabs with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};

// Links are nested inside Tabs; annotate the child for plugin completeness.
// Cascade-delete of the parent already cleans up Links via the composition
// (Composition of many DeveloperEnvironmentLinks on links.tab = $self at
// db/schema.cds:217) — the direct annotation here is belt-and-braces for
// the case where a Link exists without its parent Tab (which the schema
// prevents but the annotation should not assume).
annotate ims.DeveloperEnvironmentLinks with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  tab @PersonalData.FieldSemantics: 'DataSubjectID';
};
