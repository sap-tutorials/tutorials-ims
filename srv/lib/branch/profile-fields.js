// srv/lib/branch/profile-fields.js
//
// Single source of truth for the v1 profile vocabulary. Imported by:
//   - srv/lib/branch/profile-override.js  (allowlist check)
//   - srv/developer-service.js            (action-handler enum validation)
//   - hugo-apps/src/me/LearningPreferences.vue  (Select option lists, via
//     Vite-resolved relative path; render via v-for over PROFILE_VOCAB)
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §4.3
// Drift guard: scripts/__tests__/profile-fields-sync.test.ts asserts these
// values match the CDS enum strings on UserLearningPreferences (Task 11).

export const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'sysadmin', 'student'],
  // Issue #669: extended from [btp, aws, gcp] to cover the major cloud
  // providers. The order here is the order rendered in the Select; SAP-first
  // is deliberate. Any new value MUST be mirrored in (a) db/schema.cds
  // UserLearningPreferences.cloud enum, and (b) the CLOUD_LABEL map in
  // hugo-apps/src/me/LearningPreferences.vue. The profile-fields-sync.test.ts
  // drift guard enforces (a).
  cloud: ['btp', 'aws', 'azure', 'gcp', 'alibaba', 'oracle', 'ibm'],
};
