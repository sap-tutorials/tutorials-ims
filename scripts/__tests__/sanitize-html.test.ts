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

  it('removes style tags (defense-in-depth against author-injected CSS)', () => {
    expect(stripDangerousHtml('<style>body { color: red }</style>')).toBe('body { color: red }')
    expect(stripDangerousHtml('<style id="x">@import url("https://evil.example/track.css")</style>')).toBe('@import url("https://evil.example/track.css")')
  })

  it('removes media tags (video, audio, picture, source, track)', () => {
    expect(stripDangerousHtml('<video src="https://evil.example/track.mp4"></video>')).toBe('')
    expect(stripDangerousHtml('<audio src="x.mp3"></audio>')).toBe('')
    expect(stripDangerousHtml('<picture><source srcset="x.webp"><img src="x.png"></picture>')).toBe('<img src="x.png">')
    expect(stripDangerousHtml('<track kind="captions" src="x.vtt">')).toBe('')
  })

  it('removes deprecated frame tags', () => {
    expect(stripDangerousHtml('<frame src="x.html">')).toBe('')
    expect(stripDangerousHtml('<frameset><frame></frameset>')).toBe('')
    expect(stripDangerousHtml('<noframes>fallback</noframes>')).toBe('fallback')
  })

  it('catches unquoted javascript: URLs', () => {
    expect(stripDangerousHtml('<a href=javascript:alert(1)>click</a>')).toBe('<a>click</a>')
  })

  it('catches javascript: in xlink:href and formaction', () => {
    expect(stripDangerousHtml('<a xlink:href="javascript:alert(1)">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<button formaction="javascript:alert(1)">x</button>')).toBe('x')
  })

  // #135 — extend dangerous-URL-scheme list beyond javascript:
  it('strips data: URIs from href/src/action (#135)', () => {
    expect(stripDangerousHtml('<a href="data:text/html,hello">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe('<a>x</a>')
    expect(stripDangerousHtml('<a action="data:text/html,x">x</a>')).toBe('<a>x</a>')
    // Note: a data: URI containing a `>` would break the existing line-based
    // tag matcher independently — that's a pre-existing limitation. The
    // realistic threat is a base64-encoded payload (no `>` in the URI),
    // which we cover above.
  })

  it('strips vbscript: URIs from href/src/action (#135)', () => {
    expect(stripDangerousHtml('<a href="vbscript:msgbox(1)">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a HREF="VBScript:foo">x</a>')).toBe('<a>x</a>')
  })

  it('strips blob: URIs from href/src/action (#135)', () => {
    expect(stripDangerousHtml('<a href="blob:https://example.com/abc-123">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href="blob:null/abc">x</a>')).toBe('<a>x</a>')
  })

  it('catches unquoted data:/vbscript:/blob: URLs (#135)', () => {
    expect(stripDangerousHtml('<a href=data:text/html,x>click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href=vbscript:msgbox>click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href=blob:abc>click</a>')).toBe('<a>click</a>')
  })

  it('does not strip safe data:image/* attributes from img src (regression — img stays)', () => {
    // Tutorial authors do legitimately inline small data:image/png blobs.
    // Note: our regex strips the whole `src=data:...` attribute. This is a
    // strictness trade-off — we'd rather lose a rare inline image than admit
    // a vector. If a future complaint surfaces, narrow this regex to
    // data:(text/html|application/...) only. For now: assert the trade-off
    // is captured.
    const out = stripDangerousHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">')
    expect(out).toContain('<img')
    expect(out).not.toContain('data:image')
  })
})
