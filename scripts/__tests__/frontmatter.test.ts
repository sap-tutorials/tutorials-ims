import { describe, it, expect } from 'vitest'
import { extractFrontmatter } from '../parsers/frontmatter.js'

const SAMPLE_MD = `---
time: 15
author_name: Thomas Jung
author_profile: https://github.com/jung-thomas
tags: [ tutorial>beginner, products>sap-business-application-studio, software-product-function>sap-cloud-application-programming-model]
primary_tag: products>sap-hana-cloud
parser: v2
---

# Create an SAP Cloud Application Programming Model Project

<!-- description --> Use the wizard for the SAP Cloud Application Programming Model.

## You will learn

- How to create an application with the wizard
- How to use the local Git repository

## Prerequisites

- This tutorial is designed for SAP HANA Cloud.
- You have created a BTP instance.

### Create dev space
Step 1 content here.
`

describe('extractFrontmatter', () => {
  it('parses YAML frontmatter fields', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.frontmatter.time).toBe(15)
    expect(result.frontmatter.author_name).toBe('Thomas Jung')
    expect(result.frontmatter.primary_tag).toBe('products>sap-hana-cloud')
    expect(result.frontmatter.parser).toBe('v2')
    expect(result.frontmatter.tags).toContain('tutorial>beginner')
  })

  it('extracts title from first H1', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.title).toBe('Create an SAP Cloud Application Programming Model Project')
  })

  it('extracts description from HTML comment', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.description).toBe('Use the wizard for the SAP Cloud Application Programming Model.')
  })

  it('extracts you-will-learn bullet list', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.youWillLearn).toHaveLength(2)
    expect(result.youWillLearn[0]).toContain('wizard')
  })

  it('extracts prerequisites section', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.prerequisites).toContain('SAP HANA Cloud')
  })

  describe('youWillLearn wrapped-line folding (issue #1388)', () => {
    const make = (section: string) =>
      `---\ntime: 5\nauthor_name: x\nauthor_profile: x\ntags: []\nprimary_tag: x\n---\n\n# T\n\n## You will learn\n\n${section}\n\n## Prerequisites\n\n- something\n`

    it('folds a wrapped continuation line into its bullet instead of dropping it', () => {
      const md = make(
        '- How to build a CAP service\n  and deploy it to BTP Cloud Foundry\n- How to bind HANA',
      )
      const result = extractFrontmatter(md)
      expect(result.youWillLearn).toHaveLength(2)
      expect(result.youWillLearn[0]).toBe(
        'How to build a CAP service and deploy it to BTP Cloud Foundry',
      )
      expect(result.youWillLearn[1]).toBe('How to bind HANA')
    })

    it('ignores stray prose before the first bullet', () => {
      const md = make('Intro prose line\n- First real bullet')
      const result = extractFrontmatter(md)
      expect(result.youWillLearn).toEqual(['First real bullet'])
    })

    it('does not glue a trailing thematic break onto the last bullet', () => {
      const md = make('- Only bullet\n\n---')
      const result = extractFrontmatter(md)
      expect(result.youWillLearn).toEqual(['Only bullet'])
    })
  })

  it('normalizes level from tags', () => {
    const result = extractFrontmatter(SAMPLE_MD)
    expect(result.level).toBe('beginner')
  })

  describe('time coercion (issue #88)', () => {
    const make = (timeLine: string) => `---\n${timeLine}\nauthor_name: x\nauthor_profile: x\ntags: []\nprimary_tag: x\n---\n\n# T\n`

    it('passes through numeric time', () => {
      expect(extractFrontmatter(make('time: 30')).frontmatter.time).toBe(30)
    })

    it('strips trailing unit words like "30 mins"', () => {
      expect(extractFrontmatter(make('time: 30 mins')).frontmatter.time).toBe(30)
    })

    it('strips trailing unit words like "120 minutes"', () => {
      expect(extractFrontmatter(make('time: 120 minutes')).frontmatter.time).toBe(120)
    })

    it('drops unparseable strings so downstream defaults apply', () => {
      expect(extractFrontmatter(make('time: tbd')).frontmatter.time).toBeUndefined()
    })
  })
})
