/**
 * Unit tests for the deterministic canonical Users-row picker (#2651).
 * Pure function, no database needed.
 */
import { describe, it, expect } from 'vitest';
import { pickCanonicalRow } from '../../packages/core/resolve-db-user.js';

describe('pickCanonicalRow', () => {
  it('empty input returns null', () => {
    expect(pickCanonicalRow(null)).toBe(null);
    expect(pickCanonicalRow(undefined)).toBe(null);
    expect(pickCanonicalRow([])).toBe(null);
  });

  it('single-element input returns that element', () => {
    const row = { ID: 'test-1', sapId: 'I501234' };
    expect(pickCanonicalRow([row])).toBe(row);
  });

  it('prefers a real-sapId row over a SCIM-UUID row', () => {
    const realSapId = { ID: 'test-1', sapId: 'I501234', createdAt: '2020-01-01T00:00:00Z' };
    const scimUuid = { ID: 'test-2', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2020-01-01T00:00:00Z' };
    expect(pickCanonicalRow([scimUuid, realSapId])).toBe(realSapId);
    expect(pickCanonicalRow([realSapId, scimUuid])).toBe(realSapId);
  });

  it('all-UUID sapIds falls back to oldest createdAt', () => {
    const older = { ID: 'test-1', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2020-01-01T00:00:00Z' };
    const newer = { ID: 'test-2', sapId: 'e5d4c3b2-a1f0-4eee-beef-d1a2b3c4d5e6', createdAt: '2021-01-01T00:00:00Z' };
    expect(pickCanonicalRow([newer, older])).toBe(older);
  });

  it('a row tagged __hasRegistration wins even if newer and UUID-sapId', () => {
    const withRegistration = {
      ID: 'test-1',
      sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a',
      createdAt: '2021-01-01T00:00:00Z',
      __hasRegistration: true,
    };
    const older = {
      ID: 'test-2',
      sapId: 'I501234',
      createdAt: '2020-01-01T00:00:00Z',
    };
    expect(pickCanonicalRow([older, withRegistration])).toBe(withRegistration);
  });

  it('missing createdAt is treated as newest (loses to older rows)', () => {
    const withDate = { ID: 'test-1', sapId: 'I501234', createdAt: '2020-01-01T00:00:00Z' };
    const noDate = { ID: 'test-2', sapId: 'D123456' };
    expect(pickCanonicalRow([noDate, withDate])).toBe(withDate);
  });

  it('missing legacyId is treated as largest (loses to lower values)', () => {
    const withLegacyId = { ID: 'test-1', sapId: 'I501234', legacyId: 100 };
    const noLegacyId = { ID: 'test-2', sapId: 'D123456' };
    expect(pickCanonicalRow([noLegacyId, withLegacyId])).toBe(withLegacyId);
  });

  it('ranking priority: registration > canonical sapId > oldest > lowest legacyId', () => {
    // Row with registration wins all tiebreakers
    const hasReg = {
      ID: 'a', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2021-01-01T00:00:00Z',
      legacyId: 999, __hasRegistration: true,
    };
    // Row with canonical sapId (no registration)
    const canonicalSapId = {
      ID: 'b', sapId: 'I501234', createdAt: '2021-01-01T00:00:00Z', legacyId: 999,
    };
    // Row with oldest createdAt
    const oldest = {
      ID: 'c', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2020-01-01T00:00:00Z', legacyId: 999,
    };
    // Row with lowest legacyId (but newer createdAt, so older wins)
    const lowestLegacy = {
      ID: 'd', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2021-01-01T00:00:00Z', legacyId: 1,
    };

    expect(pickCanonicalRow([canonicalSapId, oldest, lowestLegacy, hasReg])).toBe(hasReg);
    expect(pickCanonicalRow([oldest, lowestLegacy, canonicalSapId])).toBe(canonicalSapId);
    expect(pickCanonicalRow([lowestLegacy, oldest])).toBe(oldest);
    expect(pickCanonicalRow([lowestLegacy])).toBe(lowestLegacy);
  });

  it('sapId with @ is not canonical (treated as non-canonical sapId)', () => {
    const emailLike = { ID: 'test-1', sapId: 'user@example.com', createdAt: '2021-01-01T00:00:00Z' };
    const realSapId = { ID: 'test-2', sapId: 'I501234', createdAt: '2020-01-01T00:00:00Z' };
    expect(pickCanonicalRow([emailLike, realSapId])).toBe(realSapId);
  });

  it('filters out falsy entries (null, undefined)', () => {
    const goodRow = { ID: 'test-1', sapId: 'I501234' };
    expect(pickCanonicalRow([null, undefined, goodRow])).toBe(goodRow);
  });
});
