/**
 * csrfFetch — re-export shim.
 *
 * The canonical implementation now lives at `hugo/assets/js/csrf-fetch.ts`
 * so it can be shared by the Hugo `js.Build` (esbuild) bundle — which has no
 * module mounts and can only resolve siblings under `hugo/assets/js/` — as
 * well as the hugo-apps Vite bundle and this analytics-explorer Vite bundle.
 * This file keeps the historical `../api/csrf-fetch` import path working with
 * zero churn at the existing call sites. This bundle already imports
 * out-of-root modules (see `@srv-lib` in vite.config.ts), so the reach across
 * to `hugo/assets/js` resolves the same way.
 *
 * Do NOT reintroduce a duplicate implementation here — edit the canonical
 * source. Design context:
 * docs/superpowers/specs/2026-07-02-895-csrf-reenablement-design.md
 */
export {
  csrfFetch,
  CsrfFetchError,
  _resetCsrfTokenCacheForTests,
  _seedCsrfTokenForTests,
  _getCsrfTokenForTests,
} from '../../../../hugo/assets/js/csrf-fetch';
