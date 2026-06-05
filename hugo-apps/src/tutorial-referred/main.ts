// hugo-apps/src/tutorial-referred/main.ts
//
// Vite entry loaded only on /tutorials/<slug> pages. Fires the referred_view
// telemetry event once on page load — closes the click → tutorial-load
// funnel for the / vs /browse/ A/B comparison (#204).
//
// Renamed from `tutorial` → `tutorial-referred` to avoid a path collision
// with Hugo's `js.Build` output (#251). The legacy `hugo/assets/js/tutorial.ts`
// is built by Hugo into `/js/tutorial.js`; this Vite entry would otherwise
// overwrite it (or vice versa, depending on build order). Renaming the Vite
// entry keeps both files cleanly addressable.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md

import { fireReferredView } from '@shared/analytics/referred-view'

// Tutorial slug is in the URL: /tutorials/<slug>
const slug = window.location.pathname.replace(/^\/tutorials\//, '').replace(/\/$/, '')
if (slug) fireReferredView(slug)
