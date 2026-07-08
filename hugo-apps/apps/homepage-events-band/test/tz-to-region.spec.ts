// hugo-apps/apps/homepage-events-band/test/tz-to-region.spec.ts
import { describe, it, expect } from 'vitest';
import { tzToRegion } from '../src/tz-to-region';

describe('tzToRegion', () => {
  it.each([
    ['America/New_York', 'AMERICAS'],
    ['America/Sao_Paulo', 'AMERICAS'],
    ['US/Pacific', 'AMERICAS'],
    ['Canada/Eastern', 'AMERICAS'],
    ['Europe/Berlin', 'EMEA'],
    ['Europe/London', 'EMEA'],
    ['Africa/Cairo', 'EMEA'],
    ['Atlantic/Reykjavik', 'EMEA'],
    ['Asia/Kolkata', 'APJ'],
    ['Asia/Tokyo', 'APJ'],
    ['Australia/Sydney', 'APJ'],
    ['Pacific/Auckland', 'APJ'],
    ['Indian/Mahe', 'APJ'],
    ['UTC', 'ALL'],
    ['Antarctica/McMurdo', 'ALL'],
  ])('%s → %s', (tz, expected) => {
    expect(tzToRegion(tz)).toBe(expected);
  });
});
