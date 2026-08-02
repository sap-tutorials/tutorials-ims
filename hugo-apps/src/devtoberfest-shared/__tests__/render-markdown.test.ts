// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderMarkdown } from '../render-markdown'

// Minimal markdown-it stand-in: renders # heading and returns HTML.
function installGlobals() {
  ;(globalThis as any).window = globalThis as any
  ;(globalThis as any).markdownit = () => ({
    render: (src: string) =>
      src.replace(/^# (.*)$/m, '<h1>$1</h1>').replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>'),
  })
  ;(globalThis as any).DOMPurify = {
    // Pass-through sanitizer that strips <script>.
    sanitize: (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ''),
  }
}

describe('renderMarkdown', () => {
  beforeEach(() => installGlobals())
  afterEach(() => {
    delete (globalThis as any).markdownit
    delete (globalThis as any).DOMPurify
  })

  it('renders markdown headings and links to HTML', () => {
    const out = renderMarkdown('# Hello\n\n[link](https://x.test)')
    expect(out).toContain('<h1>Hello</h1>')
    expect(out).toContain('<a href="https://x.test">link</a>')
  })

  it('strips script tags via DOMPurify', () => {
    const out = renderMarkdown('ok<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
  })

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('falls back to escaped text when globals are absent', () => {
    delete (globalThis as any).markdownit
    delete (globalThis as any).DOMPurify
    const out = renderMarkdown('<b>hi & bye</b>')
    expect(out).toBe('&lt;b&gt;hi &amp; bye&lt;/b&gt;')
  })
})
