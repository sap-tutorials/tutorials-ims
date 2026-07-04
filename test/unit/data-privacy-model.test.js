// #960 — Guards the exact @PersonalData shape after annotation cleanup.
// Failures here mean a future annotation edit slipped past reviewers. Run in
// the unit workspace (in-memory SQLite, no external deps).
//
// NOTE: @cap-js/data-privacy plugin was deferred (Task 4b, commit efa79283)
// — plugin service assertions (sap.dpp.InformationService, sap.ilm.RetentionService)
// are intentionally absent; they would fail until the plugin reaches 1.x GA
// and is re-adopted.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;
const NS = 'com.sap.developers.ims';

beforeAll(async () => {
  model = await cds.load(['db', 'srv']);
});

describe('#960 data-privacy model shape', () => {
  it('Concepts no longer carries @PersonalData (Section 1)', () => {
    const c = model.definitions[`${NS}.Concepts`];
    expect(c).toBeTruthy();
    // Neither the nested @PersonalData object nor the flat @PersonalData.EntitySemantics key
    // is present on Concepts anymore.
    expect(c['@PersonalData']).toBeUndefined();
    expect(c['@PersonalData.EntitySemantics']).toBeUndefined();
  });

  it('Concepts is @changelog-tracked (audit trail moved from @PersonalData)', () => {
    const c = model.definitions[`${NS}.Concepts`];
    // CDS compiles @changelog annotation as either '@changelog' or '@cds.changelog'
    // depending on the CDS compiler version; check both forms.
    expect(c['@changelog'] || c['@cds.changelog']).toBeTruthy();
  });

  // Task 4a: BranchDecisions reverted to Other+DataSubjectRole (not in this list)
  const dsDetailsWithDelete = [
    'PrizeRecords',
    'AccomplishmentRecords',
    'DeveloperEnvironmentTabs',
    'DeveloperEnvironmentLinks',
    // Section 2b upgrades (#960)
    'CodeCheckSubmissions',
    'ValidateAnswerSubmissions',
    'AuthorAiRequests'
    // NB: BranchDecisions reverted to Other+DataSubjectRole in Task 4a
  ];

  it.each(dsDetailsWithDelete)('%s is DataSubjectDetails + cascade delete', (name) => {
    const def = model.definitions[`${NS}.${name}`];
    expect(def).toBeTruthy();
    // CDS compiler may emit annotations as a nested object (@PersonalData: {...})
    // or as flat keys (@PersonalData.EntitySemantics, @PersonalData.cascade).
    // Normalise to one shape for the assertion.
    const entitySemantics =
      def['@PersonalData']?.EntitySemantics ?? def['@PersonalData.EntitySemantics'];
    const cascade =
      def['@PersonalData']?.cascade ?? def['@PersonalData.cascade'];
    expect(entitySemantics).toBe('DataSubjectDetails');
    expect(cascade).toBe('delete');
  });

  // BranchDecisions reverted in Task 4a; AnalyticsQueryHistory + AnalyticsSavedQuery
  // always had Other semantics.
  const otherWithRole = ['AnalyticsQueryHistory', 'AnalyticsSavedQuery', 'BranchDecisions'];

  it.each(otherWithRole)('%s stays Other + gains DataSubjectRole: Developer', (name) => {
    const def = model.definitions[`${NS}.${name}`];
    expect(def).toBeTruthy();
    const entitySemantics =
      def['@PersonalData']?.EntitySemantics ?? def['@PersonalData.EntitySemantics'];
    const dataSubjectRole =
      def['@PersonalData']?.DataSubjectRole ?? def['@PersonalData.DataSubjectRole'];
    expect(entitySemantics).toBe('Other');
    expect(dataSubjectRole).toBe('Developer');
  });
});
