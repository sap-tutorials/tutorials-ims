// test/unit/scripts/featured-mission-filter.test.ts
//
// Lock in the homepage hp-teaser "Featured missions" filter shape. The
// underlying selection is "first N mission cards in catalog order" — but
// the catalog ordering itself isn't editorial (it falls out of GitHub
// repo discovery), so without a filter the top of the homepage tends to
// surface event-bound missions (Devtoberfest, App Space, TechEd YYYY).
//
// EVENT_MISSION_RE in scripts/fetch-tutorials.ts is the sieve.
// isFeaturedMissionCandidate is the predicate we apply at writeBrowseData.
//
// Real titles in the catalog at design time (from hugo/data/browse.json):
//   - "#81A7F8 - Devtoberfest 2024 - Create an ABAP Project ..."     → exclude
//   - "Devtoberfest 2025 - Create Business Configuration ..."         → exclude
//   - "TechEd 2025 App Space"                                         → exclude
//   - "2025 TechEd App Space - Bangalore"                             → exclude
//   - "TechEd 2023 App Space Mission"                                 → exclude
//   - "Developer Garage - App Space Mission"                          → exclude
//   - "Get Started with ABAP Development on-Premise"                  → keep
//   - "SAP BTP ABAP Environment: Level Up"                            → keep
//   - "Build an SAP Fiori App Using ABAP RESTful ..."                 → keep

import { describe, it, expect } from 'vitest'
import { isFeaturedMissionCandidate, EVENT_MISSION_RE } from '../../../scripts/fetch-tutorials'

describe('isFeaturedMissionCandidate', () => {
  describe('excludes event-specific missions', () => {
    it.each([
      '#81A7F8 - Devtoberfest 2024 - Create an ABAP Project in ABAP Development Tools (ADT)',
      '#D2EAF1 - Devtoberfest 2024 - Learn about the ABAP Data Dictionary',
      'Devtoberfest 2025 - Create Business Configuration Maintenance Object',
      'Devtoberfest 2024 - Some mission',
      'Devtoberfest  2025  - whitespace variant',
    ])('rejects Devtoberfest YYYY: %s', (title) => {
      expect(isFeaturedMissionCandidate(title)).toBe(false)
    })

    it.each([
      'TechEd 2025 App Space',
      '2025 TechEd App Space - Bangalore',
      'TechEd 2023 App Space Mission',
      'Developer Garage - App Space Mission',
    ])('rejects App Space: %s', (title) => {
      expect(isFeaturedMissionCandidate(title)).toBe(false)
    })

    it('rejects a TechEd YYYY without App Space (defensive — covers future drift)', () => {
      expect(isFeaturedMissionCandidate('TechEd 2030 keynote labs')).toBe(false)
    })
  })

  describe('keeps general-audience missions', () => {
    it.each([
      'Get Started with ABAP Development on-Premise',
      'SAP BTP ABAP Environment: Level Up',
      'Get Data from an On-Premise System Using a Remote Function Call (RFC)',
      'SAP BTP ABAP Environment: Intermediate Topics',
      'Build an SAP Fiori App Using the ABAP RESTful Application Programming Model [RAP100]',
      'Get Started with GenAI Development in SAP S/4HANA',
      'Generative AI with SAP AI Core',
      'Get Started with SAP Integration Suite, advanced event mesh',
      'CAP Getting Started',
      'Learn ABAP', // plain title with no event marker
    ])('accepts: %s', (title) => {
      expect(isFeaturedMissionCandidate(title)).toBe(true)
    })
  })

  describe('case-insensitive matching', () => {
    it('rejects devtoberfest in lowercase', () => {
      expect(isFeaturedMissionCandidate('devtoberfest 2024 - something')).toBe(false)
    })
    it('rejects DEVTOBERFEST in uppercase', () => {
      expect(isFeaturedMissionCandidate('DEVTOBERFEST 2024 - SOMETHING')).toBe(false)
    })
    it('rejects app space in lowercase', () => {
      expect(isFeaturedMissionCandidate('teched 2025 app space')).toBe(false)
    })
  })

  describe('EVENT_MISSION_RE export', () => {
    it('is a RegExp', () => {
      expect(EVENT_MISSION_RE).toBeInstanceOf(RegExp)
    })

    it('has the i flag (case-insensitive)', () => {
      expect(EVENT_MISSION_RE.flags).toContain('i')
    })

    it('matches an isolated "Devtoberfest 2024" substring', () => {
      expect('Some prefix - Devtoberfest 2024 - suffix').toMatch(EVENT_MISSION_RE)
    })
  })
})
