import { describe, it, expect } from 'vitest';
import { validateAltGroupItem, AltGroupValidationError } from '../srv/handlers/completion-path-items-altgroup.js';

describe('validateAltGroupItem', () => {
  it('passes when altGroupKey is null', () => {
    expect(() => validateAltGroupItem({ altGroupKey: null }, [])).not.toThrow();
  });

  it('passes when all three fields are coherent (with enforceMultiMember)', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud', altCondition: "profile.deployment == 'cloud'" },
      [
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
      ],
      { enforceMultiMember: true }
    )).not.toThrow();
  });

  it('throws when altGroupKey is set but altGroupLabel is missing', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: null },
      []
    )).toThrow(AltGroupValidationError);
  });

  it('does NOT throw on single-member alt-group during CREATE (enforceMultiMember=false)', () => {
    // Per addendum item G: rejecting on first CREATE blocks normal authoring.
    // CREATE handler passes enforceMultiMember:false; UPDATE handler passes true.
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' },
      [{ path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' }],
      { enforceMultiMember: false }
    )).not.toThrow();
  });

  it('throws on single-member alt-group during UPDATE (enforceMultiMember=true)', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' },
      [{ path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Lonely' }],
      { enforceMultiMember: true }
    )).toThrow(/single-member/);
  });

  it('throws when altCondition is invalid syntax', () => {
    expect(() => validateAltGroupItem(
      { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'X', altCondition: 'this is not valid' },
      [
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'X' },
        { path_ID: 'p1', itemOrder: 5, altGroupKey: 'deployment', altGroupLabel: 'Y' },
      ],
      { enforceMultiMember: true }
    )).toThrow(AltGroupValidationError);
  });
});
