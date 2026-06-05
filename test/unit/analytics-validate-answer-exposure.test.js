import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('ValidateAnswerSubmissions analytics exposure', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(path.join(process.cwd(), 'db', 'schema.cds'));
  });

  it('exposes ValidateAnswerSubmissions to AnalyticsService', () => {
    const def = model.definitions['com.sap.developers.ims.ValidateAnswerSubmissions'];
    expect(def).toBeDefined();
    // Real CSN can store this as flat OR nested — check both shapes.
    const flat = def['@analytics.exposed'];
    const nested = def['@analytics']?.exposed;
    expect(flat === true || nested === true).toBe(true);
  });
});
