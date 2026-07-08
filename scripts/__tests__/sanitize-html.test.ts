import { describe, it, expect } from 'vitest'
import { stripDangerousHtml } from '../parsers/sanitize-html.js'

describe('stripDangerousHtml', () => {
  it('removes script tags AND their text content (#140)', () => {
    // sanitize-html (#140 / Path A) drops the inner text of script/style/etc.
    // Previously the regex sanitizer stripped the tag but left "alert(\"xss\")"
    // as visible text — harmless to execute but leaked the payload. Stricter
    // is better.
    const input = 'Hello <script>alert("xss")</script> world'
    expect(stripDangerousHtml(input)).toBe('Hello  world')
  })

  it('removes iframe with off-allowlist host (#140 regression guard)', () => {
    // After 2026-06-22 (iframe allowlist PR), iframes from allowlisted hosts
    // survive sanitization. This negative case proves the host check still
    // strips iframes pointing to arbitrary external hosts.
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
    // sanitize-html (#140) emits void elements with XHTML-style trailing
    // slash: `<img ... />` rather than `<img ...>`. Both are valid HTML5
    // and round-trip identically through Hugo's renderer.
    const input = '<img src="x.png" onerror="alert(1)">'
    expect(stripDangerousHtml(input)).toBe('<img src="x.png" />')
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
    expect(stripDangerousHtml(input)).toBe('<img src="https://raw.githubusercontent.com/image.png" alt="diagram" />')
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
    // Outer-fence script content is dropped under the new sanitizer (#140);
    // inner-fence content is preserved verbatim because the line is never
    // fed to the HTML parser.
    const input = '<script>bad</script>\n```\n<script>example</script>\n```\n<script>also bad</script>'
    const expected = '\n```\n<script>example</script>\n```\n'
    expect(stripDangerousHtml(input)).toBe(expected)
  })

  it('is case-insensitive for tag names (and drops script content #140)', () => {
    expect(stripDangerousHtml('<SCRIPT>x</SCRIPT>')).toBe('')
    expect(stripDangerousHtml('<Script>x</Script>')).toBe('')
  })

  it('removes svg and math wrapper tags', () => {
    expect(stripDangerousHtml('<svg onload="alert(1)"><circle></circle></svg>')).not.toContain('<svg')
    expect(stripDangerousHtml('<math><mrow></mrow></math>')).not.toContain('<math')
  })

  it('removes style tags AND their CSS content (#140)', () => {
    // Same strictness improvement as script tags: previous regex left CSS as
    // visible text. Both are non-text in #140's nonTextTags list.
    expect(stripDangerousHtml('<style>body { color: red }</style>')).toBe('')
    expect(stripDangerousHtml('<style id="x">@import url("https://evil.example/track.css")</style>')).toBe('')
  })

  it('removes media tags (video, audio, picture, source, track)', () => {
    expect(stripDangerousHtml('<video src="https://evil.example/track.mp4"></video>')).toBe('')
    expect(stripDangerousHtml('<audio src="x.mp3"></audio>')).toBe('')
    expect(stripDangerousHtml('<picture><source srcset="x.webp"><img src="x.png"></picture>')).toBe('<img src="x.png" />')
    expect(stripDangerousHtml('<track kind="captions" src="x.vtt">')).toBe('')
  })

  it('removes deprecated frame tags (and noframes content #140)', () => {
    expect(stripDangerousHtml('<frame src="x.html">')).toBe('')
    expect(stripDangerousHtml('<frameset><frame></frameset>')).toBe('')
    // <noframes> fallback content is kept (it's display text, not script);
    // the wrapper tag is stripped.
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

  // ─── #140 DOM-aware edge cases ──────────────────────────────────────────
  // The regex sanitizer was line-based and tag-naive. The new sanitize-html
  // implementation parses HTML, so we get correct handling of nested
  // attributes, malformed input, and attribute-without-quotes — cases the
  // old code couldn't reliably handle.

  it('strips attributes without quotes carrying javascript: (#140)', () => {
    expect(stripDangerousHtml('<a href=javascript:alert(1) class="x">click</a>')).toBe('<a class="x">click</a>')
  })

  it('strips event handlers with mixed case and spaces (#140)', () => {
    expect(stripDangerousHtml('<div ON_LOAD="alert(1)">x</div>')).toBe('<div>x</div>')
    expect(stripDangerousHtml('<div\tonClick="alert(1)">x</div>')).toBe('<div>x</div>')
    expect(stripDangerousHtml('<div onmouseover = "alert(1)">x</div>')).toBe('<div>x</div>')
  })

  it('handles malformed unclosed tags safely (#140)', () => {
    // The old regex line-walker could leave half-tags behind. A real parser
    // closes them or drops them.
    const out = stripDangerousHtml('<a href="https://ok.example">unclosed')
    expect(out).toContain('<a')
    expect(out).toContain('unclosed')
    expect(out).not.toMatch(/<a[^>]*>$/)  // no dangling open tag
  })

  it('drops disallowed schemes via allowlist (not blocklist) (#140)', () => {
    // Switching from blocklist (#135) to allowlist (#140) means *any* future
    // dangerous scheme is denied by default. Test a scheme that's not on
    // either list — it should be dropped.
    expect(stripDangerousHtml('<a href="ftp://example.com/x">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href="ws://example.com/x">click</a>')).toBe('<a>click</a>')
    expect(stripDangerousHtml('<a href="file:///etc/passwd">click</a>')).toBe('<a>click</a>')
  })

  it('blocks protocol-relative URLs (#140)', () => {
    // //evil.example/x.js — prior regex would let this through as an `href`
    // not starting with a known dangerous scheme. The new sanitizer's
    // allowProtocolRelative: false flag rejects it.
    expect(stripDangerousHtml('<a href="//evil.example/x.js">click</a>')).toBe('<a>click</a>')
  })

  it('preserves mailto: and anchor-only hrefs (#140)', () => {
    expect(stripDangerousHtml('<a href="mailto:hi@example.com">mail</a>')).toBe('<a href="mailto:hi@example.com">mail</a>')
    // Anchor-only href ("#section") must stay; sanitize-html's default for
    // bare hash links is to keep them.
    expect(stripDangerousHtml('<a href="#section">go</a>')).toBe('<a href="#section">go</a>')
  })

  it('preserves data-* and aria-* attributes on any allowed tag (#140)', () => {
    const input = '<button data-step="1" aria-pressed="true" class="btn">x</button>'
    // <button> is NOT in our allowed list, so the tag is stripped — but
    // the test confirms that on a tag that IS allowed, data-/aria-* survive.
    const allowed = '<div data-tutorial="x" aria-label="step one" id="s1">y</div>'
    expect(stripDangerousHtml(allowed)).toBe(allowed)
    // And the disallowed-tag path still drops <button> wrapper, keeping inner text.
    expect(stripDangerousHtml(input)).toBe('x')
  })

  it('preserves author placeholder pseudo-tags via entity encoding (#140)', () => {
    // Pseudo-tags like <SID>, <your_id>, <YOUR_TENANT_ID> aren't real HTML
    // elements. The new sanitizer pre-escapes them to `&lt;...&gt;` BEFORE
    // sanitize-html runs, so they survive and render identically in the
    // browser (browsers display unknown tags as inline-transparent text;
    // entity-encoded angle brackets render as literal `<` / `>`).
    expect(stripDangerousHtml('Login as <your>USERNAME</your>')).toBe('Login as &lt;your&gt;USERNAME&lt;/your&gt;')
    expect(stripDangerousHtml('System: <SID>S1A</SID>')).toBe('System: &lt;SID&gt;S1A&lt;/SID&gt;')
    expect(stripDangerousHtml('Tenant: <TENANT>my-tenant</TENANT>')).toBe('Tenant: &lt;TENANT&gt;my-tenant&lt;/TENANT&gt;')
  })

  it('safely entity-encodes pseudo-tags carrying attributes (#140)', () => {
    // If an author smuggles attributes onto a placeholder tag, the whole
    // token is entity-encoded — the angle brackets become &lt;/&gt; so the
    // browser parser never sees an attribute-bearing element. The literal
    // `"` is harmless inside text and stays as-is. No script execution path.
    const out = stripDangerousHtml('<your onclick="alert(1)">USERNAME</your>')
    expect(out).toBe('&lt;your onclick="alert(1)"&gt;USERNAME&lt;/your&gt;')
  })

  it('does not entity-encode bare < / > in plain markdown text (#140)', () => {
    // The line-level TAG_LIKE_RE precheck means lines without an actual HTML
    // tag are passed through verbatim — bare comparisons stay as `<`/`>`.
    expect(stripDangerousHtml('if x < 5 then y > 10')).toBe('if x < 5 then y > 10')
    expect(stripDangerousHtml('a => b => c')).toBe('a => b => c')
  })

  it('keeps img src with allowed http/https URLs unchanged (#140)', () => {
    const out = stripDangerousHtml('<img src="https://raw.githubusercontent.com/foo/bar/main/img.png" alt="x">')
    expect(out).toBe('<img src="https://raw.githubusercontent.com/foo/bar/main/img.png" alt="x" />')
  })

  it('drops javascript: URI even when wrapped in entities (#140)', () => {
    // Browsers decode entities before URL-scheme matching. Real DOM-aware
    // sanitizers handle this; the old regex did not.
    const out = stripDangerousHtml('<a href="&#106;avascript:alert(1)">x</a>')
    expect(out).toBe('<a>x</a>')
  })

  it('strips style attributes by default (#140)', () => {
    // `style` is not in our '*' attribute list, so it's dropped — author
    // CSS injection is one of the reasons we keep CSP tight.
    expect(stripDangerousHtml('<div style="background:url(javascript:alert(1))" class="x">y</div>')).toBe('<div class="x">y</div>')
  })

  it('strips srcset on img (not in allowlist) (#140)', () => {
    // srcset isn't on img's allowed-attribute list; if an author starts using
    // it, this test will fail and we extend the allowlist intentionally.
    expect(stripDangerousHtml('<img src="x.png" srcset="x@2x.png 2x" alt="y">')).toBe('<img src="x.png" alt="y" />')
  })

  // Iframe host allowlist (#140 reintroduction, 2026-06-22)

  describe('iframe host allowlist', () => {
    it('preserves YouTube /embed/ iframe with full attribute set (spec 1)', () => {
      const input = '<iframe width="560" height="315" src="https://www.youtube.com/embed/8obCwGEx1-Q" title="HANA Cloud CAP" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>'
      const out = stripDangerousHtml(input)
      // sanitize-html may reorder attrs; assert via substring matches.
      expect(out).toMatch(/<iframe\b/)
      expect(out).toMatch(/src="https:\/\/www\.youtube\.com\/embed\/8obCwGEx1-Q"/)
      expect(out).toMatch(/width="560"/)
      expect(out).toMatch(/height="315"/)
      expect(out).toMatch(/frameborder="0"/)
      expect(out).toMatch(/allow="[^"]*accelerometer/)
      expect(out).toMatch(/allowfullscreen/)
      expect(out).toMatch(/title="HANA Cloud CAP"/)
      expect(out).toMatch(/<\/iframe>/)
    })

    it('preserves youtu.be short-link iframe with src intact (spec 2)', () => {
      // Verifies youtu.be hostname is on the allowlist AND the original src
      // URL is preserved verbatim (browsers evaluate CSP frame-src against the
      // pre-redirect URL — see spec § "Why youtu.be needs an explicit entry").
      const input = '<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>'
      const out = stripDangerousHtml(input)
      expect(out).toMatch(/<iframe\b/)
      expect(out).toMatch(/src="https:\/\/youtu\.be\/dQw4w9WgXcQ"/)
    })

    it('preserves microlearning.opensap.com iframe (spec 3)', () => {
      const input = '<iframe src="https://microlearning.opensap.com/embed/secure/iframe/entryId/1_6448scfq/uiConfId/43091531"></iframe>'
      const out = stripDangerousHtml(input)
      expect(out).toMatch(/<iframe\b/)
      expect(out).toMatch(/src="https:\/\/microlearning\.opensap\.com\/embed/)
    })

    it('preserves sapvideo.cfapps.eu10-004 iframe (spec 4)', () => {
      const input = '<iframe src="https://sapvideo.cfapps.eu10-004.hana.ondemand.com/?entry_id=1_5r7r5h0n"></iframe>'
      const out = stripDangerousHtml(input)
      expect(out).toMatch(/<iframe\b/)
      expect(out).toMatch(/src="https:\/\/sapvideo\.cfapps\.eu10-004\.hana\.ondemand\.com/)
    })

    it('strips iframe from off-allowlist host (vimeo) (spec 5)', () => {
      const input = '<iframe src="https://player.vimeo.com/video/123456"></iframe>'
      expect(stripDangerousHtml(input)).toBe('')
    })

    it('strips srcdoc attribute on allowlisted-host iframe (defense-in-depth, spec 6)', () => {
      // An allowlisted-host iframe must NOT carry srcdoc — it would let an
      // author inject arbitrary inline HTML that bypasses the host check.
      const input = '<iframe src="https://www.youtube.com/embed/x" srcdoc="<script>alert(1)</script>"></iframe>'
      const out = stripDangerousHtml(input)
      expect(out).toMatch(/<iframe\b/)
      expect(out).not.toMatch(/srcdoc/)
    })

    it('strips onload/onerror handlers on allowlisted-host iframe (spec 7)', () => {
      const input = '<iframe src="https://www.youtube.com/embed/x" onload="alert(1)" onerror="alert(2)"></iframe>'
      const out = stripDangerousHtml(input)
      expect(out).toMatch(/<iframe\b/)
      expect(out).not.toMatch(/onload/)
      expect(out).not.toMatch(/onerror/)
    })

    it('strips relative-URL iframe (spec 8)', () => {
      // allowedIframeRelativeUrls: false in the sanitizer config.
      const input = '<iframe src="/api/foo"></iframe>'
      expect(stripDangerousHtml(input)).toBe('')
    })

    it('strips javascript: scheme in iframe src (spec 9)', () => {
      // The scheme allowlist (http/https/mailto) applies to src per
      // allowedSchemesAppliedToAttributes.
      const input = '<iframe src="javascript:alert(1)"></iframe>'
      expect(stripDangerousHtml(input)).toBe('')
    })

    it('preserves pseudo-tag handling for unknown <iframe-like-thing> (spec 10)', () => {
      // Hyphenated tag names that look like author placeholders should NOT
      // be consumed as iframe elements. They get escaped to literal text.
      const input = '<iframe-like-thing>placeholder</iframe-like-thing>'
      const out = stripDangerousHtml(input)
      expect(out).toContain('&lt;iframe-like-thing&gt;')
      expect(out).toContain('placeholder')
    })
  })

  // #1102: opt-in `data:` image URLs for the VSCode author-preview endpoint.
  // Default behaviour stays lockdown; preview-renderer.js passes
  // { allowDataUrls: true } via renderHugoFrontmatter → stripDangerousHtml.
  describe('allowDataUrls option (#1102)', () => {
    // Tiny 1x1 red PNG, base64.
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const dataPng = (payload: string = PNG_1x1) => `data:image/png;base64,${payload}`

    it('default (no options) strips data: image URLs — parity with pre-#1102 behaviour', () => {
      const input = `<img src="${dataPng()}" alt="screenshot">`
      // sanitize-html drops the src as a disallowed scheme, then <img> with
      // no src falls out entirely. Preserves the production security posture.
      expect(stripDangerousHtml(input)).not.toContain('data:image/png')
    })

    it('allowDataUrls:true passes through data:image/png URLs', () => {
      const input = `<img src="${dataPng()}" alt="screenshot">`
      const out = stripDangerousHtml(input, { allowDataUrls: true })
      expect(out).toContain('data:image/png;base64,')
      expect(out).toContain('alt="screenshot"')
    })

    it('allowDataUrls:true passes through the four raster MIME types', () => {
      for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
        const input = `<img src="data:${mime};base64,${PNG_1x1}" alt="x">`
        const out = stripDangerousHtml(input, { allowDataUrls: true })
        expect(out, `${mime} should survive`).toContain(`data:${mime}`)
      }
    })

    it('allowDataUrls:true STILL drops data:image/svg+xml — SVG data URLs can carry script', () => {
      // Attack vector: `data:image/svg+xml;utf8,<svg onload="fetch(...)">`.
      // Even with data URLs enabled for preview, SVG must remain blocked at
      // the sanitizer layer so a screenshot-inlining path doesn't quietly
      // become an XSS vector.
      const svgAttack = `<img src="data:image/svg+xml;utf8,%3Csvg%20onload%3D%22alert(1)%22%3E%3C%2Fsvg%3E" alt="x">`
      const out = stripDangerousHtml(svgAttack, { allowDataUrls: true })
      expect(out).not.toContain('data:image/svg+xml')
    })

    it('allowDataUrls:true drops non-image data URLs (e.g. text/html)', () => {
      // Another attack vector — `data:text/html,<script>...</script>` in
      // an <img src> won't execute (browsers don't run script in image
      // contexts), but stripping it keeps the sanitizer's contract narrow.
      const input = `<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="x">`
      const out = stripDangerousHtml(input, { allowDataUrls: true })
      expect(out).not.toContain('data:text/html')
    })

    it('allowDataUrls:true drops malformed data URLs (no MIME)', () => {
      const input = `<img src="data:garbage" alt="x">`
      const out = stripDangerousHtml(input, { allowDataUrls: true })
      expect(out).not.toContain('data:')
    })

    it('allowDataUrls:true does not affect regular http(s) img src', () => {
      const input = '<img src="https://raw.githubusercontent.com/x.png" alt="a">'
      const out = stripDangerousHtml(input, { allowDataUrls: true })
      expect(out).toContain('https://raw.githubusercontent.com/x.png')
    })

    it('allowDataUrls:true does not permit data: URLs in <a href>', () => {
      // `<a href="data:text/html,...">` is a classic phishing vector — the
      // opt-in is scoped to <img>, not global.
      const input = `<a href="data:text/html;base64,PGh0bWw+ZXZpbDwvaHRtbD4=">click</a>`
      const out = stripDangerousHtml(input, { allowDataUrls: true })
      expect(out).not.toContain('data:text/html')
      // The <a> tag itself survives with the href stripped, matching the
      // existing javascript: href test above.
      expect(out).toContain('click')
    })
  })
})
