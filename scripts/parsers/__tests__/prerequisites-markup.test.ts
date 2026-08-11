import { describe, it, expect } from 'vitest'
import { prepPrerequisitesMarkup } from '../prerequisites-markup.js'
import { composeTutorial } from '../compose.js'

const OPTS = {
  repo: 'sap-mobile-development-kit',
  branch: 'main',
  slug: 'cp-mobile-dev-kit-offline-app',
  rewriteImages: true,
}

const RAW_QR1 =
  'https://raw.githubusercontent.com/sap-tutorials/sap-mobile-development-kit/main/tutorials/cp-mobile-dev-kit-offline-app/img-1.1.1.png'

describe('prepPrerequisitesMarkup (#1637)', () => {
  it('converts a relative markdown image INSIDE a <table> to a proxied /img-cdn/ <img>', () => {
    const input =
      '<table><tr><td align="center">![Play Store QR Code](img-1.1.1.png)<br>Android</td></tr></table>'
    const out = prepPrerequisitesMarkup(input, OPTS)
    // No literal markdown image survives inside the table.
    expect(out).not.toContain('![Play Store QR Code]')
    // Rendered as a real <img> so goldmark passes it through the raw HTML block.
    expect(out).toContain(`<img src="/img-cdn/?u=${encodeURIComponent(RAW_QR1)}&w=1440"`)
    expect(out).toContain('alt="Play Store QR Code"')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('data-zoomable="true"')
    // The surrounding table markup is preserved.
    expect(out).toContain('<table>')
    expect(out).toContain('</table>')
    expect(out).toContain('<br>Android')
  })

  it('inserts a blank line after </table> when a paragraph follows with no blank line', () => {
    const input = [
      '<table><tr><td>![QR](img-1.1.1.png)</td></tr></table>',
      '(See the [custom MDK client](https://developers.sap.com/tutorials/x.html) docs.)',
    ].join('\n')
    const out = prepPrerequisitesMarkup(input, OPTS)
    // A blank line now separates the closing tag from the paragraph so goldmark
    // stops the HTML block and parses the paragraph (and its link) as markdown.
    expect(out).toMatch(/<\/table>\n\n\(See the \[custom MDK client\]/)
  })

  it('leaves a STANDALONE markdown image as markdown (render-image hook handles it) but resolves its URL', () => {
    const input = '![Diagram](arch.png)'
    const out = prepPrerequisitesMarkup(input, OPTS)
    // Still markdown syntax (not an <img> tag), but the relative path is absolute now.
    expect(out).toContain('![Diagram](https://raw.githubusercontent.com/')
    expect(out).not.toContain('<img')
  })

  it('does NOT proxy an already-absolute external image inside a table (keeps its src)', () => {
    const input =
      '<table><tr><td>![Badge](https://example.com/badge.png)</td></tr></table>'
    const out = prepPrerequisitesMarkup(input, OPTS)
    expect(out).toContain('<img src="https://example.com/badge.png"')
    expect(out).not.toContain('/img-cdn/')
  })

  it('leaves markdown links outside HTML untouched', () => {
    const input = '- See [Android](https://play.google.com/store) app'
    const out = prepPrerequisitesMarkup(input, OPTS)
    expect(out).toBe('- See [Android](https://play.google.com/store) app')
  })

  it('returns empty string for empty input', () => {
    expect(prepPrerequisitesMarkup('', OPTS)).toBe('')
  })
})

describe('composeTutorial feeds prerequisites through the markup transform (#1637)', () => {
  const md = [
    '---',
    'parser: v2',
    'title: MDK Offline',
    'time: 15',
    'tags: [tutorial>beginner]',
    'primary_tag: tutorial>beginner',
    'author_name: Tester',
    'author_profile: https://example.com',
    '---',
    '',
    '# Start Your MDK Application',
    '',
    '## Prerequisites',
    '- **Install client** on your [Android](https://play.google.com/store) device',
    '<table><tr><td align="center">![Play Store QR Code](img-1.1.1.png)<br>Android</td></tr></table>',
    '(If connecting to AliCloud, brand your [custom MDK client](https://developers.sap.com/tutorials/x.html).)',
    '',
    '## You will learn',
    '- Something',
    '',
    '### Step 1 — Setup',
    '',
    'Body content.',
  ].join('\n')

  it('emits a proxied <img> for the QR code and a blank line before the trailing paragraph', () => {
    const result = composeTutorial(md, OPTS)
    expect(result.prerequisites).toContain(`<img src="/img-cdn/?u=${encodeURIComponent(RAW_QR1)}&w=1440"`)
    expect(result.prerequisites).not.toContain('![Play Store QR Code]')
    // Trailing paragraph link is separated from the table by a blank line.
    expect(result.prerequisites).toMatch(/<\/table>\n\n\(If connecting to AliCloud/)
    // The normal bullet-list link is left as markdown.
    expect(result.prerequisites).toContain('[Android](https://play.google.com/store)')
  })
})
