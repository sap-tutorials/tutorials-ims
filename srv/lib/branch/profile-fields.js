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
  cloud: ['btp', 'aws', 'gcp'],
};
