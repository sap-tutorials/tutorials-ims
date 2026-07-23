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
  - The TrustArc smoke tests in `test/smoke/security-headers.test.js` report **SKIPPED** on an
    `inhouse`-mode deploy (TrustArc shim absent — expected) and **FAIL** on a broken
    `trustarc`-mode deploy (shim present but markers missing). They do not silently pass.
- Manual: load the site, confirm the blackbar renders, "Cookie Preferences" (footer) reopens the
  manager, and the browser console shows no CSP violations.
