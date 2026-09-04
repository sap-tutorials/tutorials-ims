import { describe, it, expect } from 'vitest';
import { filterChannels, ownerBadge } from './filter';

const data = [
  { name: 'BTP Docs', category: 'Portal', platform: 'Web', isSapOwned: true, purpose: 'docs', tags: ['btp'], focusAreas: ['btp', 'integration'], status: 'Active', ownerType: 'SAP_Official' },
  { name: 'Reddit SAP', category: 'Community', platform: 'Web', isSapOwned: false, purpose: 'forum', tags: ['community'], focusAreas: ['abap'], status: 'Active', ownerType: 'Community_Organization' },
  { name: 'SAP YouTube', category: 'Video', platform: 'YouTube', isSapOwned: true, purpose: 'tutorials', tags: ['video'], focusAreas: ['ai'], status: 'Archived', ownerType: 'SAP_Developer_Advocate' },
];

describe('filterChannels', () => {
  it('matches query across name/purpose/tags', () => {
    expect(filterChannels(data, { query: 'reddit' }).map((c) => c.name)).toEqual(['Reddit SAP']);
    expect(filterChannels(data, { query: 'btp' }).map((c) => c.name)).toEqual(['BTP Docs']);
  });
  it('filters by owner scope', () => {
    expect(filterChannels(data, { ownerScope: 'sap' }).map((c) => c.name)).toEqual(['BTP Docs', 'SAP YouTube']);
    expect(filterChannels(data, { ownerScope: 'community' }).map((c) => c.name)).toEqual(['Reddit SAP']);
  });
  it('filters by category and platform', () => {
    expect(filterChannels(data, { category: 'Portal' })).toHaveLength(1);
    // Web filter excludes the YouTube entry — proves exclusion
    expect(filterChannels(data, { platform: 'Web' })).toHaveLength(2);
    expect(filterChannels(data, { platform: 'YouTube' })).toHaveLength(1);
  });
  it('filters by focus area (membership, not equality)', () => {
    expect(filterChannels(data, { focusArea: 'integration' }).map((c) => c.name)).toEqual(['BTP Docs']);
    expect(filterChannels(data, { focusArea: 'ai' }).map((c) => c.name)).toEqual(['SAP YouTube']);
    expect(filterChannels(data, { focusArea: 'nonexistent' })).toHaveLength(0);
  });
  it('filters by status', () => {
    expect(filterChannels(data, { status: 'Active' }).map((c) => c.name)).toEqual(['BTP Docs', 'Reddit SAP']);
    expect(filterChannels(data, { status: 'Archived' }).map((c) => c.name)).toEqual(['SAP YouTube']);
  });
  it('applies multiple facets together (only rows matching ALL survive)', () => {
    // community + query: only Reddit SAP matches both
    expect(filterChannels(data, { query: 'forum', ownerScope: 'community' }).map((c) => c.name)).toEqual(['Reddit SAP']);
    // sap + category Portal: only BTP Docs matches both
    expect(filterChannels(data, { category: 'Portal', ownerScope: 'sap' }).map((c) => c.name)).toEqual(['BTP Docs']);
    // sap + Web: BTP Docs only (SAP YouTube is sap but not Web)
    expect(filterChannels(data, { ownerScope: 'sap', platform: 'Web' }).map((c) => c.name)).toEqual(['BTP Docs']);
    // focusArea + status: BTP Docs is btp+Active; Reddit is abap; no overlap
    expect(filterChannels(data, { focusArea: 'btp', status: 'Active' }).map((c) => c.name)).toEqual(['BTP Docs']);
  });
});

describe('ownerBadge', () => {
  it('derives distinct labels from ownerType (spec §10)', () => {
    expect(ownerBadge({ name: 'x', ownerType: 'SAP_Official' })).toBe('SAP');
    expect(ownerBadge({ name: 'x', ownerType: 'SAP_Executive' })).toBe('SAP');
    expect(ownerBadge({ name: 'x', ownerType: 'SAP_Developer_Advocate' })).toBe('SAP Advocate');
    expect(ownerBadge({ name: 'x', ownerType: 'Community_Member' })).toBe('Community');
    expect(ownerBadge({ name: 'x', ownerType: 'Community_Organization' })).toBe('Community');
    expect(ownerBadge({ name: 'x', ownerType: 'User_Group' })).toBe('User Group');
    expect(ownerBadge({ name: 'x', ownerType: 'Third_party_Training' })).toBe('Third-party');
    expect(ownerBadge({ name: 'x', ownerType: 'Third_party_Media' })).toBe('Third-party');
  });
  it('falls back to isSapOwned when ownerType is absent', () => {
    expect(ownerBadge({ name: 'x', isSapOwned: true })).toBe('SAP');
    expect(ownerBadge({ name: 'x', isSapOwned: false })).toBe('Community');
    expect(ownerBadge({ name: 'x' })).toBe('Community');
  });
});
