/**
 * Task 3: options-sync — sync= syntax, frontmatter fields, emission
 *
 * Tests for:
 *  - sync= parse + emit (sync attr on option-tabs, syncValue on tab)
 *  - conflicting-keys error (two blocks in one group with different sync= keys)
 *  - undeclared-key error (sync=db not in presets, not in syncGroups)
 *  - syncTabs:auto classifies Trial/Enterprise → account
 *  - syncOverrides:none disables for that step
 *  - custom syncGroups key accepted
 *  - no sync= / no syncTabs → output identical to current emission (byte-for-byte)
 */
import { describe, it, expect } from 'vitest'
import { convertOptionBlocks } from '../options.js'
import type { ConvertOptions } from '../options.js'
import { OptionSyncError } from '../options.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContent(blocks: Array<{ tab: string; syncKey?: string; body?: string }>): string {
  return blocks
    .map(
      ({ tab, syncKey, body = 'Content.' }) =>
        `[OPTION BEGIN [${tab}]${syncKey ? ` sync=${syncKey}` : ''}]\n${body}\n[OPTION END]`,
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// 1. sync= parse + emit
// ---------------------------------------------------------------------------

describe('options-sync: sync= attribute parsing and emission', () => {
  it('emits sync attr on option-tabs when first block carries sync=runtime', () => {
    const content = makeContent([
      { tab: 'Node.js', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const opts: ConvertOptions = {}
    const out = convertOptionBlocks(content, 'hugo', opts)
    expect(out).toContain('sync="runtime"')
  })

  it('emits syncValue canonical on each tab (Node.js→Node.js, Java→Java)', () => {
    const content = makeContent([
      { tab: 'Node.js', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // syncValue for Node.js (canonical via preset)
    expect(out).toContain('syncValue="Node.js"')
    // syncValue for Java (canonical via preset)
    expect(out).toContain('syncValue="Java"')
  })

  it('resolves alias label to canonical: CAP Node.js → Node.js', () => {
    const content = makeContent([
      { tab: 'CAP Node.js', syncKey: 'runtime' },
      { tab: 'CAP Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    expect(out).toContain('syncValue="Node.js"')
    expect(out).toContain('syncValue="Java"')
  })

  it('adds used key to syncKeysUsedOut', () => {
    const content = makeContent([
      { tab: 'Node.js', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const syncKeysUsedOut = new Set<string>()
    convertOptionBlocks(content, 'hugo', { syncKeysUsedOut })
    expect(syncKeysUsedOut.has('runtime')).toBe(true)
  })

  it('emits correct option-tabs shortcode shape with sync attr', () => {
    const content = makeContent([
      { tab: 'Node.js', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // Check the opening tag shape — now includes syncValues= for canonical button values
    expect(out).toMatch(/\{{% option-tabs tabs="Node\.js,Java" sync="runtime" syncValues="Node\.js,Java" %\}\}/)
  })
})

// ---------------------------------------------------------------------------
// 2. Conflicting keys in one group → build error
// ---------------------------------------------------------------------------

describe('options-sync: conflicting sync= keys in same group', () => {
  it('throws OptionSyncError when two consecutive blocks have different sync= keys', () => {
    const content = [
      '[OPTION BEGIN [Node.js] sync=runtime]\nContent A.\n[OPTION END]',
      '[OPTION BEGIN [BAS] sync=ide]\nContent B.\n[OPTION END]',
    ].join('\n')
    expect(() => convertOptionBlocks(content, 'hugo', {})).toThrow(OptionSyncError)
  })

  it('includes both conflicting keys AND a line number in the error message', () => {
    const content = [
      '[OPTION BEGIN [Node.js] sync=runtime]\nContent A.\n[OPTION END]',
      '[OPTION BEGIN [BAS] sync=ide]\nContent B.\n[OPTION END]',
    ].join('\n')
    let err: OptionSyncError | undefined
    try {
      convertOptionBlocks(content, 'hugo', {})
    } catch (e) {
      if (e instanceof OptionSyncError) err = e
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('runtime')
    expect(err!.message).toContain('ide')
    // Error must include a line number (any digit)
    expect(err!.message).toMatch(/line \d+/)
  })
})

// ---------------------------------------------------------------------------
// 3. Undeclared key → build error
// ---------------------------------------------------------------------------

describe('options-sync: undeclared sync key causes build error', () => {
  it('throws OptionSyncError when sync=db is not a preset and not in syncGroups', () => {
    const content = makeContent([
      { tab: 'HANA', syncKey: 'db' },
      { tab: 'PostgreSQL' },
    ])
    expect(() => convertOptionBlocks(content, 'hugo', {})).toThrow(OptionSyncError)
  })

  it('names the undeclared key AND a line number in the error message', () => {
    const content = makeContent([
      { tab: 'HANA', syncKey: 'db' },
      { tab: 'PostgreSQL' },
    ])
    let err: OptionSyncError | undefined
    try {
      convertOptionBlocks(content, 'hugo', {})
    } catch (e) {
      if (e instanceof OptionSyncError) err = e
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('db')
    // Error must include a line number
    expect(err!.message).toMatch(/line \d+/)
  })

  it('throws OptionSyncError for undeclared key even when syncOverrides disables that step (sync=db + none)', () => {
    // sync=db is undeclared and not a preset. Even if the step's syncOverrides
    // entry is 'none' (which would suppress sync for that step), the explicit
    // sync= key must still be validated — a typo'd key must always fail the build.
    const content = [
      '### Install Libraries',
      '',
      makeContent([{ tab: 'HANA', syncKey: 'db' }, { tab: 'PostgreSQL' }]),
    ].join('\n')
    const opts: ConvertOptions = {
      syncOverrides: { 'install-libraries': 'none' },
    }
    let err: OptionSyncError | undefined
    try {
      convertOptionBlocks(content, 'hugo', opts)
    } catch (e) {
      if (e instanceof OptionSyncError) err = e
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain('db')
  })
})

// ---------------------------------------------------------------------------
// 4. syncTabs: auto classifies Trial/Enterprise → account
// ---------------------------------------------------------------------------

describe('options-sync: syncTabs auto classification', () => {
  it('classifies [Trial, Enterprise] group as account when syncTabs=auto', () => {
    const content = makeContent([
      { tab: 'Trial' },
      { tab: 'Enterprise' },
    ])
    const opts: ConvertOptions = {
      syncTabs: 'auto',
    }
    const out = convertOptionBlocks(content, 'hugo', opts)
    expect(out).toContain('sync="account"')
    expect(out).toContain('syncValue="Trial"')
    expect(out).toContain('syncValue="Enterprise"')
  })

  it('does NOT classify when syncTabs is absent (no sync attr emitted)', () => {
    const content = makeContent([
      { tab: 'Trial' },
      { tab: 'Enterprise' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    expect(out).not.toContain('sync=')
  })

  it('adds key to syncKeysUsedOut on auto-classification', () => {
    const content = makeContent([
      { tab: 'Trial' },
      { tab: 'Enterprise' },
    ])
    const syncKeysUsedOut = new Set<string>()
    convertOptionBlocks(content, 'hugo', { syncTabs: 'auto', syncKeysUsedOut })
    expect(syncKeysUsedOut.has('account')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. syncOverrides: none disables sync for a step
// ---------------------------------------------------------------------------

describe('options-sync: syncOverrides:none disables sync for a step', () => {
  it('does not emit sync attr when syncOverrides maps step slug to "none"', () => {
    // The step heading immediately before the OPTION group determines the slug.
    const content = [
      '### Install Libraries',
      '',
      makeContent([{ tab: 'Node.js', syncKey: 'runtime' }, { tab: 'Java' }]),
    ].join('\n')
    const opts: ConvertOptions = {
      syncOverrides: { 'install-libraries': 'none' },
    }
    const out = convertOptionBlocks(content, 'hugo', opts)
    expect(out).not.toContain('sync="runtime"')
  })

  it('still emits sync attr when syncOverrides maps a DIFFERENT step slug to none', () => {
    const content = [
      '### Install Libraries',
      '',
      makeContent([{ tab: 'Node.js', syncKey: 'runtime' }, { tab: 'Java' }]),
    ].join('\n')
    const opts: ConvertOptions = {
      syncOverrides: { 'other-step': 'none' },
    }
    const out = convertOptionBlocks(content, 'hugo', opts)
    expect(out).toContain('sync="runtime"')
  })
})

// ---------------------------------------------------------------------------
// 6. Custom syncGroups key accepted (no error)
// ---------------------------------------------------------------------------

describe('options-sync: custom syncGroups key accepted', () => {
  it('accepts sync=db when syncGroups.db is declared', () => {
    const content = makeContent([
      { tab: 'HANA', syncKey: 'db' },
      { tab: 'PostgreSQL' },
    ])
    const opts: ConvertOptions = {
      syncGroups: {
        db: {
          label: 'Database',
          values: ['HANA', 'PostgreSQL'],
        },
      },
    }
    // Should not throw
    let out: string | undefined
    expect(() => {
      out = convertOptionBlocks(content, 'hugo', opts)
    }).not.toThrow()
    expect(out).toContain('sync="db"')
  })

  it('emits syncValue=label for custom group (passthrough, no aliasing needed)', () => {
    const content = makeContent([
      { tab: 'HANA', syncKey: 'db' },
      { tab: 'PostgreSQL' },
    ])
    const opts: ConvertOptions = {
      syncGroups: {
        db: {
          label: 'Database',
          values: ['HANA', 'PostgreSQL'],
        },
      },
    }
    const out = convertOptionBlocks(content, 'hugo', opts)
    expect(out).toContain('syncValue="HANA"')
    expect(out).toContain('syncValue="PostgreSQL"')
  })
})

// ---------------------------------------------------------------------------
// 7. Canonicalising preset: button data-sync-value agrees with panel syncValue
// ---------------------------------------------------------------------------

describe('options-sync: canonicalising preset — button and panel data-sync-value agree', () => {
  it('emits syncValues= on option-tabs with canonical "Node.js" for label "Node"', () => {
    // The parser should emit syncValues= so option-tabs.html can use canonical
    // values on button data-sync-value attributes (matching the panel's syncValue).
    const content = makeContent([
      { tab: 'Node', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // The strip must carry the canonical values list so the template can use it
    expect(out).toContain('syncValues="Node.js,Java"')
  })

  it('tab panel syncValue for label "Node" is canonical "Node.js"', () => {
    const content = makeContent([
      { tab: 'Node', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // Each tab panel must emit the canonical value
    expect(out).toContain('syncValue="Node.js"')
    expect(out).toContain('syncValue="Java"')
  })

  it('syncValues= and tab syncValue= use the same canonical value for each label', () => {
    // This is the core regression test: both must agree so the button's
    // data-sync-value (sourced from syncValues[i]) matches the panel's
    // data-sync-value (sourced from syncValue=).
    const content = makeContent([
      { tab: 'Node', syncKey: 'runtime' },
      { tab: 'Java' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // Strip carries canonical list
    expect(out).toMatch(/syncValues="Node\.js,Java"/)
    // Each panel carries the same canonical value
    expect(out).toMatch(/name="Node"[^"]*syncValue="Node\.js"/)
    expect(out).toMatch(/name="Java"[^"]*syncValue="Java"/)
  })
})

// ---------------------------------------------------------------------------
// 8 (was 7). Backward compat: no sync= / no syncTabs → byte-identical emission
// ---------------------------------------------------------------------------

describe('options-sync: backward compatibility — no sync attrs emitted when unused', () => {
  it('emits exact current shortcode shape when no sync= is used', () => {
    const content = makeContent([
      { tab: 'Option A' },
      { tab: 'Option B' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    // Must match current output exactly — no sync attr anywhere
    expect(out).not.toContain('sync=')
    expect(out).not.toContain('syncValue=')
    // Exact full-output assertion: catches group-numbering regressions (e.g.
    // body capture-group index shifting from 2→3 when sync= was added to regex).
    const expected = [
      '{{% option-tabs tabs="Option A,Option B" %}}',
      '{{% tab index="0" name="Option A" %}}',
      '',
      'Content.',
      '',
      '{{% /tab %}}',
      '{{% tab index="1" name="Option B" %}}',
      '',
      'Content.',
      '',
      '{{% /tab %}}',
      '{{% /option-tabs %}}',
    ].join('\n')
    expect(out).toBe(expected)
  })

  it('does not classify into a preset without syncTabs:auto even when labels match', () => {
    // [Trial, Enterprise] labels are account-classifiable but should NOT be
    // auto-classified unless syncTabs:'auto' is set.
    const content = makeContent([
      { tab: 'Trial' },
      { tab: 'Enterprise' },
    ])
    const out = convertOptionBlocks(content, 'hugo', {})
    expect(out).not.toContain('sync=')
  })
})
