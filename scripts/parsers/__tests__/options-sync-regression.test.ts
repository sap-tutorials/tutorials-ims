/**
 * Task 7 Step 1: Corpus regression test for options-sync feature.
 *
 * Goal: prove that `convertOptionBlocks(content, 'hugo', {})` on a fixture
 * with multiple OPTION groups and NO `sync=`/`syncTabs` produces:
 *  1. Byte-identical output on two independent calls (idempotency)
 *  2. No sync-related attributes in the output
 *  3. The exact expected shortcode shape (pin regression precisely)
 *
 * Also verifies that the SAME fixture WOULD be classified when syncTabs:'auto'
 * is set — proving the gate is working correctly.
 */
import { describe, it, expect } from 'vitest'
import { convertOptionBlocks } from '../options.js'
import type { ConvertOptions } from '../options.js'

// ---------------------------------------------------------------------------
// Fixture: multi-OPTION tutorial with 2+ groups, no sync= authored
// Labels include Node.js/Java (classifiable) and VS Code/BAS (classifiable)
// but sync is NOT set, so neither auto-classification nor explicit sync fires.
// ---------------------------------------------------------------------------

const FIXTURE = `### Step 1: Initialize the project

Pick your runtime:

[OPTION BEGIN [Node.js]]
Node.js content here.
[OPTION END]
[OPTION BEGIN [Java]]
Java content here.
[OPTION END]

Some text between groups.

### Step 2: Choose your IDE

[OPTION BEGIN [VS Code]]
VS Code step.
[OPTION END]
[OPTION BEGIN [BAS]]
BAS step.
[OPTION END]
`

// ---------------------------------------------------------------------------
// 1. Idempotency: two independent calls produce byte-identical output
// ---------------------------------------------------------------------------

describe('options-sync-regression: no-sync fixture is idempotent', () => {
  it('two independent calls to convertOptionBlocks produce identical output', () => {
    const out1 = convertOptionBlocks(FIXTURE, 'hugo', {})
    const out2 = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out1).toBe(out2)
  })
})

// ---------------------------------------------------------------------------
// 2. No sync-related attributes emitted
// ---------------------------------------------------------------------------

describe('options-sync-regression: no sync attributes emitted when sync= absent', () => {
  it('output contains no sync= attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).not.toContain('sync=')
  })

  it('output contains no syncValue= attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).not.toContain('syncValue=')
  })

  it('output contains no syncValues= attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).not.toContain('syncValues=')
  })

  it('output contains no data-sync-key attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).not.toContain('data-sync-key')
  })
})

// ---------------------------------------------------------------------------
// 3. Exact shortcode shape (pin the regression precisely)
// ---------------------------------------------------------------------------

describe('options-sync-regression: exact shortcode shape matches no-sync output', () => {
  it('first group (Node.js, Java) renders as plain option-tabs with no sync attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    // The option-tabs opening tag must have NO sync/syncValues attrs
    expect(out).toMatch(/\{{% option-tabs tabs="Node\.js,Java" %\}\}/)
  })

  it('second group (VS Code, BAS) renders as plain option-tabs with no sync attr', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).toMatch(/\{{% option-tabs tabs="VS Code,BAS" %\}\}/)
  })

  it('tab shortcodes have no syncValue attr (Node.js tab)', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    // Tab index=0, name=Node.js must have NO syncValue attr
    expect(out).toMatch(/\{{% tab index="0" name="Node\.js" %\}\}/)
    // Ensure the syncValue attr is absent right after name=
    expect(out).not.toMatch(/name="Node\.js" syncValue=/)
  })

  it('tab shortcodes have no syncValue attr (Java tab)', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    expect(out).toMatch(/\{{% tab index="1" name="Java" %\}\}/)
    expect(out).not.toMatch(/name="Java" syncValue=/)
  })

  it('full output matches expected no-sync shortcode shape for group 1', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    const expectedGroup1 = [
      '{{% option-tabs tabs="Node.js,Java" %}}',
      '{{% tab index="0" name="Node.js" %}}',
      '',
      'Node.js content here.',
      '',
      '{{% /tab %}}',
      '{{% tab index="1" name="Java" %}}',
      '',
      'Java content here.',
      '',
      '{{% /tab %}}',
      '{{% /option-tabs %}}',
    ].join('\n')
    expect(out).toContain(expectedGroup1)
  })

  it('full output matches expected no-sync shortcode shape for group 2', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    const expectedGroup2 = [
      '{{% option-tabs tabs="VS Code,BAS" %}}',
      '{{% tab index="0" name="VS Code" %}}',
      '',
      'VS Code step.',
      '',
      '{{% /tab %}}',
      '{{% tab index="1" name="BAS" %}}',
      '',
      'BAS step.',
      '',
      '{{% /tab %}}',
      '{{% /option-tabs %}}',
    ].join('\n')
    expect(out).toContain(expectedGroup2)
  })

  it('complete output matches full expected string byte-identically', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', {})
    const EXPECTED = [
      '### Step 1: Initialize the project',
      '',
      'Pick your runtime:',
      '',
      '{{% option-tabs tabs="Node.js,Java" %}}',
      '{{% tab index="0" name="Node.js" %}}',
      '',
      'Node.js content here.',
      '',
      '{{% /tab %}}',
      '{{% tab index="1" name="Java" %}}',
      '',
      'Java content here.',
      '',
      '{{% /tab %}}',
      '{{% /option-tabs %}}',
      '',
      'Some text between groups.',
      '',
      '### Step 2: Choose your IDE',
      '',
      '{{% option-tabs tabs="VS Code,BAS" %}}',
      '{{% tab index="0" name="VS Code" %}}',
      '',
      'VS Code step.',
      '',
      '{{% /tab %}}',
      '{{% tab index="1" name="BAS" %}}',
      '',
      'BAS step.',
      '',
      '{{% /tab %}}',
      '{{% /option-tabs %}}',
      '',
    ].join('\n')
    expect(out).toBe(EXPECTED)
  })
})

// ---------------------------------------------------------------------------
// 4. Gate check: same fixture DOES classify with syncTabs:'auto'
//    (proves the no-sync gate is working — the labels ARE classifiable)
// ---------------------------------------------------------------------------

describe('options-sync-regression: syncTabs:auto DOES classify the same fixture', () => {
  it('classifies Node.js/Java group as runtime when syncTabs=auto', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', { syncTabs: 'auto' })
    // The runtime group must now carry sync=
    expect(out).toContain('sync="runtime"')
  })

  it('classifies VS Code/BAS group as ide when syncTabs=auto', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', { syncTabs: 'auto' })
    expect(out).toContain('sync="ide"')
  })

  it('auto classification emits syncValue on Node.js tab', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', { syncTabs: 'auto' })
    expect(out).toContain('syncValue="Node.js"')
  })

  it('auto classification emits syncValue on BAS tab', () => {
    const out = convertOptionBlocks(FIXTURE, 'hugo', { syncTabs: 'auto' })
    expect(out).toContain('syncValue="BAS"')
  })
})
