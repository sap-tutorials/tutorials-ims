import { describe, it, expect } from 'vitest'
import {
  scanSource,
  rebuildSource,
  goldenRenderEqual,
  chunk,
} from '../../scripts/scan-markdown-source.js'
import { stripImageDirectiveComments } from '../../scripts/parsers/images.js'

const META = { slug: 'demo', repo: 'r', branch: 'b' }

// Minimal-but-valid tutorial frontmatter so composeTutorial (golden-render gate)
// runs without throwing. Body holds the malformed pattern under test.
const FM = [
  '---',
  'title: Demo',
  'description: A demo',
  'auto_validation: true',
  'time: 10',
  'tags: [ tutorial>beginner ]',
  'primary_tag: x',
  '---',
  '',
].join('\n')

function doc(body: string): string {
  return FM + body
}

describe('scan-markdown-source', () => {
  describe('list-continuation-fence (#1931)', () => {
    const body = [
      '## Step 1',
      'Enter the code:',
      '',
      '    ```ABAP',
      '    START-OF-SELECTION.',
      '    ```',
      '',
    ].join('\n')

    it('detects the 4-space-indented fence', () => {
      const { findings } = scanSource(doc(body), META)
      const fence = findings.filter(f => f.class === 'list-continuation-fence')
      expect(fence).toHaveLength(1)
      expect(fence[0].issue).toBe('#1931')
      expect(fence[0].classification).toBe('source-fixable')
      // Line is in FILE space (frontmatter offset applied).
      expect(fence[0].line).toBe(FM.split('\n').length - 1 + 4)
    })

    it('de-indents fence delimiters + content 4→3 spaces', () => {
      const { fixedBody } = scanSource(doc(body), META)
      expect(fixedBody).not.toBeNull()
      expect(fixedBody).toContain('   ```ABAP')      // 3 spaces
      expect(fixedBody).not.toContain('    ```ABAP') // not 4
    })

    it('is idempotent: re-scanning the fixed source yields no source-fixable change', () => {
      const { fixedBody } = scanSource(doc(body), META)
      const fixedSrc = rebuildSource(doc(body), fixedBody!)
      const second = scanSource(fixedSrc, META)
      expect(second.fixedBody).toBeNull()
      expect(second.findings.filter(f => f.classification === 'source-fixable')).toHaveLength(0)
    })

    it('passes the golden-render gate (compose output unchanged)', () => {
      const original = doc(body)
      const { fixedBody } = scanSource(original, META)
      const fixed = rebuildSource(original, fixedBody!)
      expect(goldenRenderEqual(original, fixed, META)).toBe(true)
    })
  })

  describe('blockquote-fence', () => {
    const body = [
      '## Step 1',
      'Example:',
      '',
      '> ```JSON',
      '{',
      '  "a": 1',
      '}',
      '> ```',
      '',
    ].join('\n')

    it('detects un-prefixed blockquote fence content', () => {
      const { findings } = scanSource(doc(body), META)
      expect(findings.some(f => f.class === 'blockquote-fence')).toBe(true)
    })

    it('re-prefixes content lines with > and passes golden gate', () => {
      const original = doc(body)
      const { fixedBody } = scanSource(original, META)
      expect(fixedBody).not.toBeNull()
      const fixed = rebuildSource(original, fixedBody!)
      expect(goldenRenderEqual(original, fixed, META)).toBe(true)
    })
  })

  describe('image-directive-comment (#1137)', () => {
    const body = [
      '## Step 1',
      '',
      '<!-- border -->![Alt](step.png)',
      '',
    ].join('\n')

    it('detects the directive comment', () => {
      const { findings } = scanSource(doc(body), META)
      expect(findings.some(f => f.class === 'image-directive-comment')).toBe(true)
    })

    it('strips it in the fix, leaving the image', () => {
      const { fixedBody } = scanSource(doc(body), META)
      expect(fixedBody).toContain('![Alt](step.png)')
      expect(fixedBody).not.toContain('<!-- border -->')
    })
  })

  describe('stripImageDirectiveComments (shared with images.ts pre-processor)', () => {
    it('strips border + size directives, keeps unrelated comments', () => {
      expect(stripImageDirectiveComments('<!-- border; size:540px -->![a](x.png)')).toBe('![a](x.png)')
      expect(stripImageDirectiveComments('<!-- keepme -->![a](x.png)')).toBe('<!-- keepme -->![a](x.png)')
    })
    it('is idempotent', () => {
      const once = stripImageDirectiveComments('<!-- border -->![a](x.png)')
      expect(stripImageDirectiveComments(once)).toBe(once)
    })
  })

  describe('render-time classes are report-only, never written', () => {
    const body = [
      '## Step 1',
      'Template uses {{ .Site }} outside a code fence.',
      '',
    ].join('\n')

    it('reports hugo-delimiters but produces no source fix', () => {
      const { findings, fixedBody } = scanSource(doc(body), META)
      expect(findings.some(f => f.class === 'hugo-delimiters' && f.classification === 'render-time')).toBe(true)
      // No source-fixable class fired → nothing to write.
      expect(fixedBody).toBeNull()
    })
  })

  describe('frontmatter + EOL preservation', () => {
    const body = [
      '## Step 1',
      'Code:',
      '',
      '    ```ABAP',
      '    x.',
      '    ```',
      '',
    ].join('\n')

    it('keeps the frontmatter block byte-for-byte', () => {
      const original = doc(body)
      const { fixedBody } = scanSource(original, META)
      const fixed = rebuildSource(original, fixedBody!)
      expect(fixed.startsWith(FM)).toBe(true)
    })

    it('restores CRLF line endings when the source was CRLF', () => {
      const original = doc(body).replace(/\n/g, '\r\n')
      const { fixedBody } = scanSource(original, META)
      const fixed = rebuildSource(original, fixedBody!)
      expect(fixed.includes('\r\n')).toBe(true)
      expect(/([^\r])\n/.test(fixed)).toBe(false) // no bare LF
    })

    it('keeps LF when the source was LF', () => {
      const original = doc(body)
      const { fixedBody } = scanSource(original, META)
      const fixed = rebuildSource(original, fixedBody!)
      expect(fixed.includes('\r\n')).toBe(false)
    })
  })

  describe('chunk (≤N tutorials per PR)', () => {
    it('splits into fixed-size batches, last may be short', () => {
      const items = Array.from({ length: 23 }, (_, i) => i)
      const batches = chunk(items, 10)
      expect(batches.map(b => b.length)).toEqual([10, 10, 3])
    })
    it('one batch when under the limit', () => {
      expect(chunk([1, 2], 10)).toHaveLength(1)
    })
    it('empty input → no batches', () => {
      expect(chunk([], 10)).toEqual([])
    })
  })
})
