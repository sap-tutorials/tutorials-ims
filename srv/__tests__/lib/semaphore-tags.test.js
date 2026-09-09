// srv/__tests__/lib/semaphore-tags.test.js
import '@sap/cds'; // registers SELECT/CQL globals used by getSemaphoreMdMap
import { describe, it, expect } from 'vitest';
import { getSemaphoreMdMap, formatSmTechIds } from '../../lib/semaphore-tags.js';

// Fake db: ignores the query, returns canned Tags rows.
function fakeDb(rows) {
  return { run: async () => rows };
}

describe('getSemaphoreMdMap', () => {
  it('keys by mdFormat, keeps only non-null semaphoreId', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '7355001', isActualTag: true },
      { titlePath: 'Software Product : Technology Platform / SAP AI Services', semaphoreId: null, isActualTag: true },
    ]));
    expect(map).toEqual({ 'software-product>sap-hana': '7355001' });
  });

  it('last-write-wins on duplicate mdFormat', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '111', isActualTag: true },
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '222', isActualTag: true },
    ]));
    expect(map).toEqual({ 'software-product>sap-hana': '222' });
  });

  it('drops rows whose titlePath yields empty mdFormat', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: '', semaphoreId: '999' },
    ]));
    expect(map).toEqual({});
  });

  it('emits every tag with a semaphoreId regardless of isActualTag', async () => {
    const map = await getSemaphoreMdMap(fakeDb([
      { titlePath: 'Software Product : Technology Platform / SAP HANA', semaphoreId: '111', isActualTag: true },
      { titlePath: 'Programming Tool / ABAP Development', semaphoreId: '222', isActualTag: false },
      { titlePath: 'Topic / Machine Learning', semaphoreId: '333' },
    ]));
    expect(map).toEqual({
      'software-product>sap-hana': '111',
      'programming-tool>abap-development': '222',
      'topic>machine-learning': '333',
    });
  });
});

describe('formatSmTechIds', () => {
  it('prefixes locale, comma-joins, no spaces', () => {
    expect(formatSmTechIds(['111', '222'])).toBe('en-US,111,222');
  });
  it('returns empty string for empty/nullish list', () => {
    expect(formatSmTechIds([])).toBe('');
    expect(formatSmTechIds(undefined)).toBe('');
  });
  it('dedupes preserving first-seen order', () => {
    expect(formatSmTechIds(['111', '222', '111'])).toBe('en-US,111,222');
  });
  it('honours an explicit locale', () => {
    expect(formatSmTechIds(['111'], 'de-DE')).toBe('de-DE,111');
  });
});
