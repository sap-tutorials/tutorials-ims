import { describe, it, expect } from 'vitest';
import {
  AUDIT_MAP, isCandidate, candidateRe, NS,
} from '../../scripts/btp-audit/fields.cjs';

describe('btp-audit fields map', () => {
  it('covers exactly the five in-scope entities with correct keys and fields', () => {
    const byEntity = Object.fromEntries(AUDIT_MAP.map(m => [m.entity, m]));
    expect(Object.keys(byEntity).sort()).toEqual([
      'HomepageFeaturedTopics', 'HomepageForYouCandidates',
      'HomepageShelves', 'ShelfDefinitions', 'VerbDefinitions',
    ]);
    expect(byEntity.HomepageShelves.keyField).toBe('ID');
    expect(byEntity.HomepageShelves.textFields).toEqual(
      ['title', 'description', 'tagline', 'whyItMatters']);
    expect(byEntity.VerbDefinitions.keyField).toBe('verbKey');
    expect(byEntity.ShelfDefinitions.keyField).toBe('shelfKey');
    expect(byEntity.HomepageFeaturedTopics.textFields).toEqual(
      ['displayTitle', 'notes']);
  });

  it('derives HANA table names as COM_SAP_DEVELOPERS_IMS_<ENTITY>', () => {
    const shelves = AUDIT_MAP.find(m => m.entity === 'HomepageShelves');
    expect(shelves.hanaTable).toBe('COM_SAP_DEVELOPERS_IMS_HOMEPAGESHELVES');
    expect(shelves.hanaKeyCol).toBe('ID');
    const verbs = AUDIT_MAP.find(m => m.entity === 'VerbDefinitions');
    expect(verbs.hanaKeyCol).toBe('VERBKEY');
  });

  it('isCandidate matches BTP variants case-insensitively, ignores non-strings', () => {
    expect(isCandidate('Deploy to SAP BTP today')).toBe(true);
    expect(isCandidate('the business technology platform')).toBe(true);
    expect(isCandidate('Use the btp CLI')).toBe(true);
    expect(isCandidate('Just plain tutorial text')).toBe(false);
    expect(isCandidate(null)).toBe(false);
    expect(isCandidate(42)).toBe(false);
  });

  it('candidateRe() returns a fresh non-global regex each call', () => {
    const a = candidateRe();
    const b = candidateRe();
    expect(a).not.toBe(b);
    expect(a.global).toBe(false);
    expect(NS).toBe('com.sap.developers.ims');
  });
});
