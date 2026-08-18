import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../compose.js'

describe('composeTutorial branches integration (#172 PR 3)', () => {
  it('attaches branchGroup + branches to the parent step on v2 with [BRANCH_BEGIN]', () => {
    const md = [
      '---',
      'parser: v2',
      'title: Test',
      'time: 5',
      'tags: [tutorial>beginner]',
      'primary_tag: tutorial>beginner',
      'author_name: Tester',
      'author_profile: https://example.com',
      '---',
      '',
      '# Test',
      '',
      '### Step 1 — Setup',
      '',
      'Pick deployment:',
      '',
      '[BRANCH_BEGIN group="deployment" key="hana" label="HANA Cloud"]',
      '### Sub HANA',
      'HANA content.',
      '[BRANCH_END]',
      '',
      '[BRANCH_BEGIN group="deployment" key="postgres" label="PostgreSQL"]',
      '### Sub Postgres',
      'Postgres content.',
      '[BRANCH_END]',
      '',
      '### Step 2 — Continue',
      '',
      'Done.',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'test-slug',
      target: 'hugo',
      rewriteImages: false,
    })
    const step1 = result.steps.find(s => s.number === 1)
    expect(step1?.branchGroup).toBe('deployment')
    expect(step1?.branchPointId).toBe('1-deployment')
    expect(step1?.branches).toHaveLength(2)
    expect(step1?.branches?.[0].key).toBe('hana')
    expect(step1?.branches?.[1].key).toBe('postgres')

    // Step 2 should be untouched.
    const step2 = result.steps.find(s => s.number === 2)
    expect(step2?.branchGroup).toBeUndefined()
    expect(step2?.branches).toBeUndefined()
  })

  it('leaves v1 tutorials unchanged (no branch metadata, no errors)', () => {
    const md = [
      '---',
      'title: V1 Test',
      'time: 5',
      'tags: [tutorial>beginner]',
      'primary_tag: tutorial>beginner',
      'author_name: Tester',
      'author_profile: https://example.com',
      '---',
      '',
      '# V1 Test',
      '',
      '[ACCORDION-BEGIN [Step 1: ](Setup)]',
      'Some content.',
      '[ACCORDION-END]',
    ].join('\n')

    const result = composeTutorial(md, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'test-v1',
      target: 'hugo',
      rewriteImages: false,
    })
    // No assertion on step contents — just that no error was thrown and
    // no branch fields ended up populated.
    for (const s of result.steps) {
      expect(s.branchGroup).toBeUndefined()
      expect(s.branches).toBeUndefined()
    }
  })
})

describe('composeTutorial "You will learn" image rewriting', () => {
  // Regression: an author put prose + inline images inside the `## You will
  // learn` section. extractBulletList folds that trailing content into the last
  // bullet, but youWillLearn bypassed the body/prerequisites image-URL rewriter,
  // so relative `![alt](HCC.png)` survived as a bare relative src that 404s on
  // the served page. Mirror the #1637 prerequisites fix: youWillLearn images
  // must resolve to absolute raw.githubusercontent URLs (which the Hugo
  // render-image hook then routes through /img-cdn/).
  const md = [
    '---',
    'title: HANA Cloud Automation CLI',
    'time: 20',
    'tags: [tutorial>intermediate]',
    'primary_tag: tutorial>intermediate',
    'author_name: Tester',
    'author_profile: https://example.com',
    '---',
    '',
    '# HANA Cloud Automation CLI',
    '',
    '## You will learn',
    '  - How to execute SQL commands from the command line',
    '  - An overview of two runtimes',
    '',
    'SAP HANA Cloud Central can be used to perform many administrative tasks.',
    '',
    '![SAP HANA Cloud Central](HCC.png)',
    '',
    'A text-based interface can be faster.',
    '',
    '![running and scheduling tasks](running-scheduling.png)',
    '',
    '### First step',
    '',
    'Body.',
  ].join('\n')

  it('rewrites relative image URLs in youWillLearn to absolute raw URLs', () => {
    const result = composeTutorial(md, {
      repo: 'Tutorials',
      branch: 'master',
      slug: 'hana-cloud-automation-cli',
      target: 'hugo',
      rewriteImages: true,
    })
    const joined = result.youWillLearn.join('\n')
    const base =
      'https://raw.githubusercontent.com/sap-tutorials/Tutorials/master/tutorials/hana-cloud-automation-cli'
    expect(joined).toContain(`${base}/HCC.png`)
    expect(joined).toContain(`${base}/running-scheduling.png`)
    // The bare relative form must be gone (it resolves against the page URL → 404).
    expect(joined).not.toContain('](HCC.png)')
    expect(joined).not.toContain('](running-scheduling.png)')
  })

  it('leaves youWillLearn image URLs untouched when rewriteImages is false', () => {
    const result = composeTutorial(md, {
      repo: 'Tutorials',
      branch: 'master',
      slug: 'hana-cloud-automation-cli',
      target: 'hugo',
      rewriteImages: false,
    })
    const joined = result.youWillLearn.join('\n')
    expect(joined).toContain('](HCC.png)')
  })
})

describe('composeTutorial CRLF regression (#432)', () => {
  it('produces non-zero steps for a real-world CRLF v2 tutorial shape', () => {
    // This fixture mirrors the actual structure of btp-cockpit-setup.md as it
    // arrived in the upstream repo: parser: v2 declared, three ### H3 step
    // headings, and \r\n line endings throughout.
    const md = [
      '---',
      'parser: v2',
      'author_name: Tester',
      'time: 5',
      'tags: [tutorial>beginner, software-product>sap-business-technology-platform]',
      'primary_tag: software-product>sap-business-technology-platform',
      '---',
      '',
      '# Get an SAP BTP Account for Tutorials',
      '<!-- description --> Learn which account model on SAP Business Technology Platform is best suited for your purposes.',
      '',
      '## You will learn',
      '  - How to decide which account model is suited for you',
      '',
      '---',
      '',
      '### Understanding Trial vs. Free Tier',
      '',
      'Body of step one.',
      '',
      '### Which to choose?',
      '',
      'Body of step two.',
      '',
      '### How to set up an account',
      '',
      'Body of step three.',
    ].join('\r\n')  // <- critical: full CRLF input

    const result = composeTutorial(md, {
      repo: 'sap-tutorials/sap-cloud-platform',
      branch: 'main',
      slug: 'btp-cockpit-setup',
      target: 'hugo',
      rewriteImages: false,
    })

    expect(result.steps).toHaveLength(3)
    expect(result.steps.map(s => s.title)).toEqual([
      'Understanding Trial vs. Free Tier',
      'Which to choose?',
      'How to set up an account',
    ])
  })
})
