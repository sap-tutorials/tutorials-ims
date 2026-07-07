// test/unit/region-from-location.test.js
// #1030 — region derivation from CommunityEvents.location free-form strings.

import { describe, it, expect } from 'vitest';
import { regionFromLocation } from '../../srv/lib/events/region-from-location.js';

describe('regionFromLocation', () => {
  describe('AMERICAS', () => {
    it.each([
      ['USA', 'AMERICAS'],
      ['United States', 'AMERICAS'],
      ['Canada', 'AMERICAS'],
      ['Toronto, Canada', 'AMERICAS'],
      ['New York, NY, USA', 'AMERICAS'],
      ['São Paulo, Brazil', 'AMERICAS'],
      ['Mexico City, Mexico', 'AMERICAS'],
      ['Americas', 'AMERICAS'],
    ])('classifies %s as AMERICAS', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('EMEA', () => {
    it.each([
      ['Berlin, Germany', 'EMEA'],
      ['London, UK', 'EMEA'],
      ['Paris, France', 'EMEA'],
      ['Amsterdam, Netherlands', 'EMEA'],
      ['Cape Town, South Africa', 'EMEA'],
      ['Dubai, UAE', 'EMEA'],
      ['Tel Aviv, Israel', 'EMEA'],
      ['Europe', 'EMEA'],
      ['EMEA', 'EMEA'],
    ])('classifies %s as EMEA', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('APJ', () => {
    it.each([
      ['Bangalore, India', 'APJ'],
      ['Bengaluru', 'APJ'],
      ['Singapore', 'APJ'],
      ['Tokyo, Japan', 'APJ'],
      ['Sydney, Australia', 'APJ'],
      ['Seoul, South Korea', 'APJ'],
      ['Shanghai, China', 'APJ'],
      ['APJ', 'APJ'],
      ['APAC region', 'APJ'],
    ])('classifies %s as APJ', (input, expected) => {
      expect(regionFromLocation(input)).toBe(expected);
    });
  });

  describe('UNKNOWN sentinel', () => {
    it('returns UNKNOWN for null', () => {
      expect(regionFromLocation(null)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for undefined', () => {
      expect(regionFromLocation(undefined)).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for empty string', () => {
      expect(regionFromLocation('')).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for the "virtual" sentinel (region is orthogonal to virtuality)', () => {
      expect(regionFromLocation('virtual')).toBe('UNKNOWN');
      expect(regionFromLocation('Virtual')).toBe('UNKNOWN');
      expect(regionFromLocation('VIRTUAL')).toBe('UNKNOWN');
    });

    it('returns UNKNOWN for unrecognized locations', () => {
      expect(regionFromLocation('Antarctica')).toBe('UNKNOWN');
      expect(regionFromLocation('Somewhere in space')).toBe('UNKNOWN');
    });
  });

  describe('specificity ordering (first match wins)', () => {
    it('matches city before generic region term', () => {
      // "Berlin" (city) → EMEA even if the string somehow contains "Americas"
      expect(regionFromLocation('Berlin Americas Center')).toBe('EMEA');
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(regionFromLocation('BERLIN, GERMANY')).toBe('EMEA');
      expect(regionFromLocation('bangalore')).toBe('APJ');
    });
  });
});
