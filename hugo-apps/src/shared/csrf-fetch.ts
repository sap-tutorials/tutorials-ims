/**
 * csrfFetch — re-export shim.
 *
 * The canonical implementation now lives at `hugo/assets/js/csrf-fetch.ts`
 * so it can be shared by the Hugo `js.Build` (esbuild) bundle — which has no
 * module mounts and can only resolve siblings under `hugo/assets/js/` — as
 * well as this hugo-apps Vite bundle and the analytics-explorer Vite bundle.
 * This file keeps the historical `@shared/csrf-fetch` import path (and the
 * co-located `csrf-fetch.test.ts`) working with zero churn at ~20 call sites.
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
} from '../../../hugo/assets/js/csrf-fetch';
