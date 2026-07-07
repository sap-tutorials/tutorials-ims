import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// #1034 SAP News developer-relevance filter — schema shape guard.
// Uses cds.load(['db', 'srv']) (local convention; returns model directly)
// instead of cds.load('*') + cds.model.definitions because on this project
// cds.model is null after cds.deploy on Windows (ESM singleton divergence).
// See data-privacy-model.test.js for the established pattern.

let model;

describe('#1034 schema additions', () => {
  beforeAll(async () => {
    // Loads compiled model; no DB deploy needed for shape assertions.
    model = await cds.load(['db', 'srv']);
  });

  it('NewsItems entity exists with expected keys and columns', () => {
    const ent = model.definitions['com.sap.developers.ims.external.NewsItems'];
    expect(ent).toBeTruthy();
    expect(ent.elements.sourceId.key).toBe(true);
    expect(ent.elements.link).toBeTruthy();
    expect(ent.elements.title).toBeTruthy();
    expect(ent.elements.description).toBeTruthy();
    expect(ent.elements.publishedAt).toBeTruthy();
    expect(ent.elements.language).toBeTruthy();
    expect(ent.elements.contentHash).toBeTruthy();
    expect(ent.elements.aiVerdict).toBeTruthy();
    expect(ent.elements.aiReason).toBeTruthy();
    expect(ent.elements.aiVerdictSource).toBeTruthy();
    expect(ent.elements.aiConfidence).toBeTruthy();
    expect(ent.elements.aiVerdictAt).toBeTruthy();
    expect(ent.elements.aiModel).toBeTruthy();
    expect(ent.elements.adminVerdict).toBeTruthy();
    expect(ent.elements.adminNote).toBeTruthy();
    expect(ent.elements.adminBy).toBeTruthy();
    expect(ent.elements.adminAt).toBeTruthy();
    expect(ent.elements.lastFetchedAt).toBeTruthy();
    expect(ent.elements.classifyError).toBeTruthy();
  });

  it('RelevanceSeedExemplars entity exists with embedding column', () => {
    const ent = model.definitions['com.sap.developers.ims.external.RelevanceSeedExemplars'];
    expect(ent).toBeTruthy();
    expect(ent.elements.ID.key).toBe(true);
    expect(ent.elements.label).toBeTruthy();
    expect(ent.elements.text).toBeTruthy();
    expect(ent.elements.embedding).toBeTruthy();
    expect(ent.elements.active).toBeTruthy();
    expect(ent.elements.note).toBeTruthy();
  });

  it('ChatSettings gains #1034 columns', () => {
    const ent = model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(ent.elements.newsRelevanceLlmBudgetPerDay).toBeTruthy();
    expect(ent.elements.newsRelevanceMargin).toBeTruthy();
    expect(ent.elements.newsFetchCadenceMinutes).toBeTruthy();
    expect(ent.elements.newsRelevanceLlmCallsToday).toBeTruthy();
    expect(ent.elements.newsRelevanceLlmCallsCountedOn).toBeTruthy();
  });

  it('HomepageConfig gains newsRelevanceEnabled', () => {
    const ent = model.definitions['com.sap.developers.ims.HomepageConfig'];
    expect(ent.elements.newsRelevanceEnabled).toBeTruthy();
  });
});
