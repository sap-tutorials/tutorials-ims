# TrustArc CMP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the in-house consent banner for the corporate TrustArc CMP (property `sapshared.com`) already live in legacy AEM, behind a build-time feature flag with an in-house fallback.

**Architecture:** A Hugo site param `params.cmp` (`trustarc` default / `inhouse` fallback / `off`) selects the consent path in a new `partials/consent.html`, replacing the hardcoded `consent.js` script tag in `baseof.html`. TrustArc mode emits the SAP wrapper bootstrap, the `teconsent`/`consent_blackbar` anchor divs, TrustArc's notice+asset scripts, a reload handler, and a `consent-trustarc.js` shim that re-implements `window.consent.*` over `truste.eu`/`PrivacyManagerAPI`. CSP in `approuter/xs-app.json` gains the two TrustArc domains.

**Tech Stack:** Hugo (TOML config, Go templates), vanilla JS (no build step for `hugo/static/js/`), `@sap/approuter` (CSP via `xs-app.json`), Vitest (smoke tests).

## Global Constraints

- **Parity is the mandate** — reproduce legacy values verbatim; do not "improve" them (`country=US`, `noticeType=bb`, `pn=1-0`, `js=nj`, `c=teconsent`).
- **Property ID `domain=sapshared.com`** — NOT the SAP wrapper's cosmetic `www.developers.sap.com`.
- **Exact notice URL:** `https://consent.trustarc.com/notice?domain=sapshared.com&c=teconsent&gtm=1&js=nj&noticeType=bb&pn=1-0&country=US&text=true&privacypolicylink=https%3A%2F%2Fwww.sap.com%2Fabout%2Flegal%2Fprivacy.html`
- **Asset script (version-pinned):** `https://consent.trustarc.com/asset/notice.js/v/v1.7-484`
- **CSP domains:** `https://consent.trustarc.com` (script/img/font/connect) + `https://user-consent-center.trustarc.com` (connect only). Do NOT add `static.trustarc.com`.
- **`cmp` default is `trustarc`.** No Legal gate — already approved in production legacy.
- **Property values single-sourced** in `hugo/hugo.toml [params]`; templates read them, never hardcode.
- **`window.consent.*` API must keep working** — footer `consent.show()` (`footer.html:37`) is the one live consumer; do not edit the footer.
- **Never throw** in the shim — degrade to "required-only" if `truste`/`PrivacyManagerAPI` absent.
- **Windows/CRLF:** author `.js`/`.html` with LF line endings; verify no CRLF introduced.
- **Worktree:** all work on branch `worktree-trustarc-cmp`; run file-mutating Bash from the worktree path, never `cd` out.

---

### Task 1: Add TrustArc config params

**Files:**
- Modify: `hugo/hugo.toml:6-13` (the `[params]` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `site.Params.cmp` (string: `trustarc`|`inhouse`|`off`), `site.Params.trustArcDomain` (string), `site.Params.trustArcPrivacyLink` (string), `site.Params.trustArcNoticeAssetVersion` (string). Consumed by Task 3's partial.

- [ ] **Step 1: Add the params**

In `hugo/hugo.toml`, inside the existing `[params]` block (currently lines 6-13, after `defaultOgImage`), add:

```toml
  # Consent Management Platform selector — see docs/superpowers/specs/2026-07-23-trustarc-cmp-integration-design.md
  # 'trustarc' = corporate TrustArc CMP (default, parity with legacy AEM)
  # 'inhouse'  = break-glass fallback to the self-contained banner (hugo/static/js/consent.js)
  # 'off'      = emit no consent UI (QA/preview builds)
  cmp = 'trustarc'
  trustArcDomain = 'sapshared.com'
  trustArcPrivacyLink = 'https://www.sap.com/about/legal/privacy.html'
  trustArcNoticeAssetVersion = 'v1.7-484'
```

- [ ] **Step 2: Verify Hugo parses the config**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp/hugo && hugo config | grep -iE 'cmp|trustarc'`
Expected: output includes `cmp = "trustarc"`, `trustarcdomain = "sapshared.com"`, `trustarcprivacylink = ...`, `trustarcnoticeassetversion = "v1.7-484"` (Hugo lowercases param keys in `hugo config` output).

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add hugo/hugo.toml
git commit -m "feat(consent): add TrustArc CMP config params (cmp/trustArcDomain/…)"
```

---

### Task 2: Add the `window.consent.*` shim over TrustArc

**Files:**
- Create: `hugo/static/js/consent-trustarc.js`

**Interfaces:**
- Consumes: global `window.truste.eu` (`reopenBanner()`, `addEventListener(evt, fn)`), global `window.PrivacyManagerAPI.callApi('getConsentDecision', domain)`, cookies `cmapi_cookie_privacy` / `notice_gdpr_prefs`.
- Produces: `window.consent` object with `has(category)`, `show()`, `onChange(fn)` — same API surface as `hugo/static/js/consent.js`. `data-ta-domain` read from the script tag's own dataset (set by Task 3).

- [ ] **Step 1: Write the shim**

Create `hugo/static/js/consent-trustarc.js` with LF line endings:

```js
/**
 * window.consent.* compatibility shim over the TrustArc CMP.
 *
 * Preserves the API shape of hugo/static/js/consent.js so the footer
 * "Cookie Preferences" button (footer.html:37) and any future has()/onChange()
 * callers keep working unchanged when cmp=trustarc.
 *
 * Category map: required=group 0, functional=group 1, advertising=group 2
 * (TrustArc numeric consent groups, confirmed from live sapshared.com property).
 *
 * Never throws — degrades to "required-only" if TrustArc globals are absent.
 */
(function () {
  'use strict';

  var GROUP = { required: 0, functional: 1, advertising: 2 };
  var pending = [];
  var subscribers = [];

  function taDomain() {
    var s = document.currentScript || document.querySelector('script[data-ta-domain]');
    return (s && s.getAttribute('data-ta-domain')) || 'sapshared.com';
  }

  // Parse "permit 1,2,3" style cmapi cookie → set of permitted group numbers.
  function permittedFromCookie() {
    try {
      var m = document.cookie.match(/cmapi_cookie_privacy=permit ([0-9,]+)/);
      if (!m) return null;
      var set = {};
      m[1].split(',').forEach(function (n) { set[parseInt(n, 10)] = true; });
      return set;
    } catch (e) { return null; }
  }

  function hasCategory(category) {
    var group = GROUP[category];
    if (group === 0 || group === undefined) return true; // required always on
    // Preferred: PrivacyManagerAPI structured decision.
    try {
      if (window.PrivacyManagerAPI && typeof window.PrivacyManagerAPI.callApi === 'function') {
        var d = window.PrivacyManagerAPI.callApi('getConsentDecision', taDomain());
        if (d && Array.isArray(d.consentDecision)) return d.consentDecision.indexOf(group) !== -1;
        // Some builds return a max-permitted integer; treat >=group as consented.
        if (d && typeof d.consentDecision === 'number') return d.consentDecision >= group + 1;
      }
    } catch (e) { /* fall through to cookie */ }
    var permitted = permittedFromCookie();
    if (permitted) return !!permitted[group + 1]; // cmapi is 1-indexed (1,2,3)
    return false; // unknown → not consented (safe default for non-required)
  }

  function show() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.reopenBanner === 'function') {
        window.truste.eu.reopenBanner();
        return;
      }
    } catch (e) { /* not ready */ }
    pending.push(show); // queue until truste is ready
  }

  function flushPending() {
    var q = pending.slice(); pending.length = 0;
    q.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    subscribers.push(fn);
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.addEventListener === 'function') {
        window.truste.eu.addEventListener('consent', function () {
          try { fn(readCategories()); } catch (e) {}
        });
      }
    } catch (e) { /* addEventListener absent → no live updates, has() still works */ }
  }

  function readCategories() {
    return {
      required: true,
      functional: hasCategory('functional'),
      advertising: hasCategory('advertising'),
    };
  }

  window.consent = {
    has: function (category) { return hasCategory(category); },
    show: show,
    onChange: onChange,
  };

  // When TrustArc finishes loading, flush any queued show() calls.
  // truste.eu.runOnReady exists on the live property; guard for absence.
  function wireReady() {
    try {
      if (window.truste && window.truste.eu && typeof window.truste.eu.runOnReady === 'function') {
        window.truste.eu.runOnReady(flushPending);
        return true;
      }
    } catch (e) {}
    return false;
  }
  if (!wireReady()) {
    var tries = 0;
    var iv = setInterval(function () {
      if (wireReady() || ++tries > 40) { clearInterval(iv); flushPending(); }
    }, 250); // up to ~10s, then give up and flush best-effort
  }
})();
```

- [ ] **Step 2: Lint for syntax**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp && node --check hugo/static/js/consent-trustarc.js`
Expected: no output, exit 0 (valid JS).

- [ ] **Step 3: Verify LF line endings**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp && file hugo/static/js/consent-trustarc.js && grep -c $'\r' hugo/static/js/consent-trustarc.js || true`
Expected: `grep -c` prints `0` (no CR characters).

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add hugo/static/js/consent-trustarc.js
git commit -m "feat(consent): add window.consent.* shim over TrustArc (reopenBanner/PrivacyManagerAPI)"
```

---

### Task 3: Create the `consent.html` partial and wire it into baseof

**Files:**
- Create: `hugo/layouts/partials/consent.html`
- Modify: `hugo/layouts/_default/baseof.html:50` (replace the hardcoded `consent.js` script tag)

**Interfaces:**
- Consumes: `site.Params.cmp`, `site.Params.trustArcDomain`, `site.Params.trustArcPrivacyLink`, `site.Params.trustArcNoticeAssetVersion` (Task 1); `hugo/static/js/consent-trustarc.js` (Task 2); `site.Params.qa`, `site.Params.previewMode` (existing).
- Produces: the emitted consent markup. No downstream consumer.

- [ ] **Step 1: Write the partial**

Create `hugo/layouts/partials/consent.html` with LF line endings:

```go-html-template
{{- /*
  Consent Management Platform switch. See:
  docs/superpowers/specs/2026-07-23-trustarc-cmp-integration-design.md
  QA and preview builds never show a live consent banner.
*/ -}}
{{- $cmp := site.Params.cmp | default "trustarc" -}}
{{- if or site.Params.qa site.Params.previewMode -}}
  {{- $cmp = "off" -}}
{{- end -}}
{{- if eq $cmp "trustarc" -}}
  {{- $domain := site.Params.trustArcDomain | default "sapshared.com" -}}
  {{- $privacy := site.Params.trustArcPrivacyLink | default "https://www.sap.com/about/legal/privacy.html" -}}
  {{- $assetVer := site.Params.trustArcNoticeAssetVersion | default "v1.7-484" -}}
  <script>
    (function () {
      window.SAP = window.SAP || {};
      window.SAP.global = {
        trustArc: {
          domain: {{ $domain | jsonify }},
          privacyPolicyLink: {{ $privacy | jsonify }}
        },
        isProd: /(www|developers)(\.sap\.(com|cn)|-preprod|-prod)/.test(location.host)
      };
    })();
  </script>
  <div id="consent_blackbar"></div>
  <div id="teconsent"></div>
  <script async src="https://consent.trustarc.com/notice?domain={{ $domain }}&c=teconsent&gtm=1&js=nj&noticeType=bb&pn=1-0&country=US&text=true&privacypolicylink={{ $privacy | querify | replaceRE "^[^=]*=" "" }}"></script>
  <script async src="https://consent.trustarc.com/asset/notice.js/v/{{ $assetVer }}"></script>
  <script>
    document.body.addEventListener('click', function (event) {
      if (event && event.target && event.target.id === 'truste-consent-button') {
        try {
          sessionStorage.setItem('referrerBeforeTrustArcReload', document.referrer);
          sessionStorage.setItem('referrerBeforeTrustArcReloadUpdateTime', new Date().getTime());
        } catch (e) {}
        setTimeout(function () { window.location.reload(); }, 1000);
      }
    });
  </script>
  <script defer src="/js/consent-trustarc.js" data-ta-domain="{{ $domain }}"></script>
{{- else if eq $cmp "inhouse" -}}
  <script defer src="/js/consent.js"></script>
{{- end -}}
{{- /* cmp=off emits nothing */ -}}
```

Note: The `privacypolicylink` is the raw value URL-encoded via `querify`. If `querify` proves awkward, hardcode the encoded literal `https%3A%2F%2Fwww.sap.com%2Fabout%2Flegal%2Fprivacy.html` (parity value) — this is acceptable since the privacy link is a constant.

- [ ] **Step 2: Replace the hardcoded tag in baseof.html**

In `hugo/layouts/_default/baseof.html`, replace line 50:

```html
  <script defer src="/js/consent.js"></script>
```

with:

```html
  {{ partial "consent.html" . }}
```

- [ ] **Step 3: Build and assert TrustArc markup is emitted (default)**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp/hugo && hugo --quiet --destination /tmp/ta-default && \
  grep -l 'consent.trustarc.com/notice?domain=sapshared.com' /tmp/ta-default/index.html && \
  grep -o 'id="teconsent"' /tmp/ta-default/index.html && \
  grep -o 'id="consent_blackbar"' /tmp/ta-default/index.html && \
  grep -o '/js/consent-trustarc.js' /tmp/ta-default/index.html && \
  ! grep -q '"/js/consent.js"' /tmp/ta-default/index.html && echo "TRUSTARC-OK"
```
Expected: prints the matched lines then `TRUSTARC-OK` (TrustArc tags present, in-house `consent.js` absent).

- [ ] **Step 4: Build with `cmp=inhouse` and assert fallback**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp/hugo && hugo --quiet --destination /tmp/ta-inhouse -p '{cmp: inhouse}' 2>/dev/null || \
  HUGO_PARAMS_CMP=inhouse hugo --quiet --destination /tmp/ta-inhouse && \
  grep -o '"/js/consent.js"' /tmp/ta-inhouse/index.html && \
  ! grep -q 'consent.trustarc.com' /tmp/ta-inhouse/index.html && echo "INHOUSE-OK"
```
Expected: prints `/js/consent.js` match then `INHOUSE-OK`. (Hugo reads `HUGO_PARAMS_CMP` env override; use whichever override form works — verify one succeeds.)

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add hugo/layouts/partials/consent.html hugo/layouts/_default/baseof.html
git commit -m "feat(consent): consent.html partial switching TrustArc/inhouse/off; wire into baseof"
```

---

### Task 4: Add TrustArc domains to the CSP

**Files:**
- Modify: `approuter/xs-app.json:6` (the `Content-Security-Policy` value)

**Interfaces:**
- Consumes: nothing.
- Produces: CSP header allowing TrustArc. Verified by Task 5's smoke test.

- [ ] **Step 1: Edit the CSP value**

In `approuter/xs-app.json` line 6, apply these four additions to the single-line CSP value:

- `script-src`: after `https://www.youtube.com` add ` https://consent.trustarc.com`
- `img-src`: after `data:` (before the `;`) add ` https://consent.trustarc.com`
- `style-src`: no change
- `font-src`: after `https://cdn.jsdelivr.net` add ` https://consent.trustarc.com`
- `connect-src`: after the existing `wss://*.cfapps.eu10-005.hana.ondemand.com` add ` https://consent.trustarc.com https://user-consent-center.trustarc.com`

Resulting CSP value (verify each directive matches):

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://ui5.sap.com https://www.youtube.com https://consent.trustarc.com; worker-src 'self' blob:; frame-src https://www.youtube.com https://youtube.com https://youtu.be https://microlearning.opensap.com https://sapvideo.cfapps.eu10-004.hana.ondemand.com; img-src 'self' https://raw.githubusercontent.com https://avatars.githubusercontent.com https://github.com https://*.sap.com https://i.ytimg.com data: https://consent.trustarc.com; style-src 'self' 'unsafe-inline' https://*.sap.com https://ui5.sap.com https://unpkg.com; font-src 'self' https://*.sap.com https://ui5.sap.com https://unpkg.com https://cdn.jsdelivr.net https://consent.trustarc.com; connect-src 'self' https://ui5.sap.com https://*.cfapps.eu10-005.hana.ondemand.com wss://*.cfapps.eu10-005.hana.ondemand.com https://consent.trustarc.com https://user-consent-center.trustarc.com
```

- [ ] **Step 2: Verify JSON is valid**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp && jq -e '.responseHeaders[] | select(.name=="Content-Security-Policy") | .value | test("consent.trustarc.com") and test("user-consent-center.trustarc.com")' approuter/xs-app.json`
Expected: prints `true`, exit 0 (valid JSON, both domains present).

- [ ] **Step 3: Confirm `static.trustarc.com` was NOT added**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp && ! grep -q 'static.trustarc.com' approuter/xs-app.json && echo "NO-STATIC-OK"`
Expected: `NO-STATIC-OK`.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add approuter/xs-app.json
git commit -m "feat(consent): allow TrustArc domains in CSP (consent + user-consent-center)"
```

---

### Task 5: Add the CSP smoke test

**Files:**
- Modify: `test/smoke/security-headers.test.js` (append a TrustArc assertion block)

**Interfaces:**
- Consumes: `BASE_URL`, `fetchWithRetry` from `./smoke.config.js` (existing pattern).
- Produces: a smoke test guarding the CSP/markup lockstep.

- [ ] **Step 1: Add the test block**

In `test/smoke/security-headers.test.js`, before the final `);` that closes the `describe`, add two tests inside the existing `describe` body (after the `script-src allows known SAP hosts` test at line 42):

```js
    it('CSP allows TrustArc consent domain (#trustarc-cmp)', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toMatch(/script-src[^;]*consent\.trustarc\.com/);
      expect(csp).toMatch(/connect-src[^;]*user-consent-center\.trustarc\.com/);
    });

    it('serves the TrustArc notice script in the homepage HTML (#trustarc-cmp)', async () => {
      const res = await fetchWithRetry(`${BASE_URL}/`);
      const html = await res.text();
      // Only asserts when the deployed build is in trustarc mode (default).
      // If a deploy is rolled back to cmp=inhouse this will be skipped by content.
      if (html.includes('/js/consent-trustarc.js')) {
        expect(html).toMatch(/consent\.trustarc\.com\/notice\?domain=sapshared\.com/);
        expect(html).toContain('id="teconsent"');
      }
    });
```

- [ ] **Step 2: Run against a deployed base URL (if available)**

Run: `cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp && SMOKE_BASE_URL=https://<dev-approuter-url> npx vitest run test/smoke/security-headers.test.js`
Expected: PASS. If no deployed URL is available yet, the suite `skipIf`s on missing/localhost `BASE_URL` — confirm it reports skipped, not failed.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add test/smoke/security-headers.test.js
git commit -m "test(consent): smoke-assert TrustArc CSP + notice script on deployed homepage"
```

---

### Task 6: Update documentation

**Files:**
- Modify: `docs/historic/aem-gap-analysis.md` (the #13 Cookie Consent note, ~line 252-258)
- Modify: `docs/developers/reference/cookie-and-storage-analysis.md` (§2.5, §4.3, §5)
- Create: `docs/developers/operations/consent-cmp-rollback.md`

**Interfaces:**
- Consumes: nothing.
- Produces: docs only.

- [ ] **Step 1: Update the gap-analysis note**

In `docs/historic/aem-gap-analysis.md`, append to the #13 section (after the existing "Note for future work" paragraph):

```markdown

**Update 2026-07-23 — TrustArc wired (parity).** The corporate TrustArc CMP is now the default (`cmp: trustarc`), using the shared SAP property `domain=sapshared.com` — the same property the legacy AEM site served. The in-house banner (`hugo/static/js/consent.js`) is retained as a break-glass fallback (`cmp: inhouse`). `window.consent.*` is preserved via `hugo/static/js/consent-trustarc.js`. See `docs/superpowers/specs/2026-07-23-trustarc-cmp-integration-design.md` and the rollback runbook `docs/developers/operations/consent-cmp-rollback.md`.
```

- [ ] **Step 2: Update the cookie/storage analysis**

In `docs/developers/reference/cookie-and-storage-analysis.md`:
- §2.5 ("Cookies the application does not set"): remove the blanket "no consent banner" implication and add a row noting TrustArc now sets `notice_behavior`, `notice_gdpr_prefs`, `notice_preferences`, `cmapi_cookie_privacy` on the origin (third-party CMP, category: strictly-necessary consent record).
- §4.3 ("No consent banner exists today"): mark resolved — TrustArc live as of 2026-07-23.
- §5 (posture summary table): update the "Does it have a consent banner?" row to **Yes — TrustArc (`sapshared.com`)**.

Add this row to the §3 / cookie inventory area:

```markdown
| `notice_gdpr_prefs`, `notice_behavior`, `cmapi_cookie_privacy`, `notice_preferences` | TrustArc CMP (`consent.trustarc.com`) | Consent state per category (groups 0/1/2) | Records the visitor's cookie-consent decision | **Strictly necessary** — consent record itself |
```

- [ ] **Step 3: Write the rollback runbook**

Create `docs/developers/operations/consent-cmp-rollback.md`:

```markdown
# Consent CMP — Rollback Runbook

The consent path is selected by the Hugo param `cmp` in `hugo/hugo.toml`:

| Value | Behavior |
|-------|----------|
| `trustarc` (default) | Corporate TrustArc CMP, property `sapshared.com`. |
| `inhouse` | Self-contained banner `hugo/static/js/consent.js`. |
| `off` | No consent UI (auto-selected for QA/preview builds). |

## Rolling back TrustArc → in-house

1. Edit `hugo/hugo.toml [params]`: set `cmp = 'inhouse'`.
2. Rebuild + redeploy the approuter (full content build; Hugo must finish before `mbt build`).
3. (Hygiene, optional) revert the TrustArc CSP entries in `approuter/xs-app.json`
   (`consent.trustarc.com`, `user-consent-center.trustarc.com`). Leaving them is harmless —
   nothing loads them in `inhouse` mode.

## CSP entries TrustArc requires

- `script-src`, `img-src`, `font-src`, `connect-src`: `https://consent.trustarc.com`
- `connect-src` (also): `https://user-consent-center.trustarc.com`
- Do NOT add `static.trustarc.com` — the property never contacts it.

## Property values (single-sourced in `hugo/hugo.toml`)

- `trustArcDomain = 'sapshared.com'` — the shared SAP TrustArc property ID.
- `trustArcNoticeAssetVersion = 'v1.7-484'` — pinned `notice.js` version; refresh periodically
  by re-capturing from the live legacy site.

## Verifying a deployed TrustArc build

- `npm run test:smoke` with `SMOKE_BASE_URL` set — asserts CSP + notice script.
- Manual: load the site, confirm the blackbar renders, "Cookie Preferences" (footer) reopens the
  manager, and the browser console shows no CSP violations.
```

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/trustarc-cmp
git add docs/historic/aem-gap-analysis.md docs/developers/reference/cookie-and-storage-analysis.md docs/developers/operations/consent-cmp-rollback.md
git commit -m "docs(consent): record TrustArc parity swap + rollback runbook"
```

---

## Security decision: no Subresource Integrity (SRI) on TrustArc tags

Automated tooling will flag the external `<script src>` tags for missing `integrity="sha384-…"`.
**Do not add SRI here — it is incorrect for this integration:**

- The notice endpoint (`consent.trustarc.com/notice?domain=…`) returns geo- and
  session-varying content on every request; there is no stable hash.
- `asset/notice.js` is a TrustArc-controlled CDN asset that changes independently of the
  version path; a pinned hash would break the CMP the moment TrustArc ships a patch.
- The legacy production site (the parity target) serves these as plain `<script src>` with no
  SRI — confirmed from the live capture.

SRI is the right control for pinned self-hosted vendor bundles, not a live third-party CMP. The
compensating control is the CSP allow-list (Task 4), which restricts script loading to
`consent.trustarc.com` only. Leave the tags without `integrity`/`crossorigin` and do not
re-flag.

## Notes for the implementer

- **Hugo param override syntax (Task 3, Step 4):** Hugo accepts env-var overrides as `HUGO_PARAMS_<KEY>` (uppercase). `HUGO_PARAMS_CMP=inhouse hugo …` is the reliable form; the `-p '{...}'` form is not a real Hugo flag — prefer the env var. Verify the fallback build actually flips before asserting.
- **`querify`/URL encoding (Task 3, Step 1):** the only dynamic-looking piece is `privacypolicylink`, which is a constant. If Hugo's URL encoding fights you, hardcode the parity-encoded literal `https%3A%2F%2Fwww.sap.com%2Fabout%2Flegal%2Fprivacy.html` in the two script `src`s and drop the `querify` gymnastics. Parity value, constant — this is fine.
- **Do not run `hugo` from the primary tree** — only from the worktree's `hugo/` dir.
- **`/tmp` on Windows Git Bash** maps under the MSYS root; if `/tmp` writes fail, use `$CLAUDE_JOB_DIR/tmp` for the `--destination`.
