// hugo-apps/src/tutorial/main.ts
//
// Vite entry loaded only on /tutorials/<slug> pages. Fires the referred_view
// telemetry event once on page load — closes the click → tutorial-load
// funnel for the / vs /browse/ A/B comparison (#204).
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md

import { fireReferredView } from '@shared/analytics/referred-view'

// Tutorial slug is in the URL: /tutorials/<slug>
const slug = window.location.pathname.replace(/^\/tutorials\//, '').replace(/\/$/, '')
if (slug) fireReferredView(slug)
