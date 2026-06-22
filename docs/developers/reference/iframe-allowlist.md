# Tutorial iframe host allowlist

Tutorial markdown can embed `<iframe>` elements from a small set of
SAP-blessed video hosts. The allowlist is enforced at three layers, each
providing defense-in-depth against the other two.

## Enforcement layers

1. **Sanitizer** ([scripts/parsers/sanitize-html.ts](../../../scripts/parsers/sanitize-html.ts))
   strips iframes whose src hostname is not on the list at build time.
2. **CSP** ([approuter/xs-app.json](../../../approuter/xs-app.json))
   makes the browser refuse to render iframes whose src host is not in
   `frame-src` at runtime.
3. **Lint** ([scripts/lint-rules/iframe-non-allowlisted-host.ts](../../../scripts/lint-rules/iframe-non-allowlisted-host.ts))
   warns tutorial authors at PR time before the sanitizer silently strips
   their content.

## Current allowlist

| Host | Rationale |
|---|---|
| `www.youtube.com` | YouTube embed - the most common video host in the catalog (~129 occurrences). |
| `youtube.com` | YouTube bare-domain form - occasional author variant. |
| `youtu.be` | YouTube short-link form. Browsers evaluate CSP against the original src URL *before* any redirect, so this needs its own entry. |
| `microlearning.opensap.com` | SAP openSAP microlearning embed (~7 occurrences). |
| `sapvideo.cfapps.eu10-004.hana.ondemand.com` | SAP internal video service. |

## Extending the allowlist

Three files must be updated together:

1. **Sanitizer constant** - [scripts/parsers/sanitize-html.ts](../../../scripts/parsers/sanitize-html.ts),
   the `ALLOWED_IFRAME_HOSTNAMES` array.
2. **CSP `frame-src`** - [approuter/xs-app.json](../../../approuter/xs-app.json),
   line 6 (the single `Content-Security-Policy` value, `frame-src` directive).
3. **This doc page** - the table above.

The lint rule **auto-updates** because it imports `ALLOWED_IFRAME_HOSTNAMES`.

After the three-file change, the next MTA redeploy activates the new
allowlist on DEV/QA/PROD.

## Attribute allowlist

Allowed iframe attributes (defense-in-depth - narrower than HTML5 defaults):

- `src` - host-checked by `allowedIframeHostnames`, scheme-checked by `allowedSchemes`
- `width`, `height` - author-controlled sizing
- `frameborder` - legacy attribute, harmless
- `allow` - feature-policy delegation
- `allowfullscreen` - fullscreen permission flag
- `title` - a11y label
- `loading` - performance hint (`lazy`)
- `referrerpolicy` - privacy attribute

**Deliberately excluded:** `srcdoc` (would allow inline HTML bypassing the
host allowlist), `name` (deprecated), `sandbox` (authors should not relax
our defaults), `on*` event handlers (always stripped by sanitize-html).

## History

- **PR #141** (issue #136, 2025-05-31) - migrated from a regex sanitizer to
  the `sanitize-html` npm package. Iframes were deliberately stripped
  because the regex sanitizer couldn't enforce a hostname allowlist.
  YouTube embeds in ~65 catalog tutorials silently disappeared.
- **PR #560** (2026-06-22) - re-introduced a narrow iframe
  allowlist using `sanitize-html`'s `allowedIframeHostnames` option +
  the matching CSP `frame-src` directive + a lint rule that warns
  authors at PR time. Surfaced when Tom noticed the missing "Video
  Version" embed on `/tutorials/hana-cloud-cap-create-project`.
