import { describe, it, expect } from 'vitest'
import { stripDangerousHtml } from '../parsers/sanitize-html.js'

describe('stripDangerousHtml', () => {
  it('removes script tags', () => {
    const input = 'Hello <script>alert("xss")</script> world'
    expect(stripDangerousHtml(input)).toBe('Hello alert("xss") world')
  })

  it('removes iframe tags', () => {
    const input = '<iframe src="https://evil.com"></iframe>'
    expect(stripDangerousHtml(input)).toBe('')
  })

  it('removes object, embed, applet tags', () => {
    expect(stripDangerousHtml('<object data="x"></object>')).toBe('')
    expect(stripDangerousHtml('<embed src="x">')).toBe('')
    expect(stripDangerousHtml('<applet code="x"></applet>')).toBe('')
  })

  it('removes form-related tags', () => {
    expect(stripDangerousHtml('<form action="/steal"><input type="text"></form>')).toBe('')
  })

  it('removes event handler attributes', () => {
    const input = '<img src="x.png" onerror="alert(1)">'
    expect(stripDangerousHtml(input)).toBe('<img src="x.png">')
  })

  it('removes onload attributes', () => {
    const input = '<div onload="fetch(\'evil.com\')" class="box">content</div>'
    expect(stripDangerousHtml(input)).toBe('<div class="box">content</div>')
  })

  it('removes javascript: hrefs', () => {
    const input = '<a href="javascript:alert(1)">click</a>'
    expect(stripDangerousHtml(input)).toBe('<a>click</a>')
  })

  it('preserves safe HTML tags', () => {
    const input = '<div class="note"><p>Hello <strong>world</strong></p></div>'
    expect(stripDangerousHtml(input)).toBe(input)
  })

  it('preserves img tags without event handlers', () => {
    const input = '<img src="https://raw.githubusercontent.com/image.png" alt="diagram">'
    expect(stripDangerousHtml(input)).toBe(input)
  })

  it('preserves table tags', () => {
    const input = '<table><tr><td>cell</td></tr></table>'
    expect(stripDangerousHtml(input)).toBe(input)
  })

  it('does not modify content inside code fences', () => {
    const input = '```html\n<script>alert("example")</script>\n```'
    expect(stripDangerousHtml(input)).toBe(input)
  })

  it('handles tilde code fences', () => {
    const input = '~~~\n<script>var x = 1;</script>\n~~~'
    expect(stripDangerousHtml(input)).toBe(input)
  })

  it('sanitizes outside but not inside code fences', () => {
    const input = '<script>bad</script>\n```\n<script>example</script>\n```\n<script>also bad</script>'
    const expected = 'bad\n```\n<script>example</script>\n```\nalso bad'
    expect(stripDangerousHtml(input)).toBe(expected)
  })

  it('is case-insensitive for tag names', () => {
    expect(stripDangerousHtml('<SCRIPT>x</SCRIPT>')).toBe('x')
    expect(stripDangerousHtml('<Script>x</Script>')).toBe('x')
  })

  it('removes svg and math wrapper tags', () => {
    expect(stripDangerousHtml('<svg onload="alert(1)"><circle></circle></svg>')).not.toContain('<svg')
    expect(stripDangerousHtml('<math><mrow></mrow></math>')).not.toContain('<math')
  })
})
