// srv/lib/alert-cta-targets.js
//
// Canonical list of suggested CTA targets for alerts.
//
// This is the code-only source of truth — any new route that should appear
// in the admin "CTA URL" value-help must be added HERE. The list seeds the
// AdminService.AlertCtaTargets read-only entity, which Fiori Elements uses
// as the value-help collection. Free text is still allowed (the value-help
// is declared as ValueListWithFixedValues: false), so admins can type an
// external URL — this list just provides quick-pick suggestions for the
// common in-app destinations.

export const CTA_TARGETS = Object.freeze([
  Object.freeze({ url: '/',                     label: 'Home' }),
  Object.freeze({ url: '/browse/',              label: 'Browse' }),
  Object.freeze({ url: '/devtoberfest/',        label: 'Devtoberfest' }),
  Object.freeze({ url: '/developer-advocates/', label: 'Developer Advocates' }),
  Object.freeze({ url: '/me',                   label: 'My Completions' }),
  Object.freeze({ url: '/app-space',            label: 'App Space' }),
  Object.freeze({ url: '/event-display',        label: 'Event Display' }),
]);

/**
 * Returns a shallow copy of the canonical CTA-target list.
 *
 * This list is the code-only source of truth for the admin "CTA URL"
 * value-help. Adding a new route to the site (e.g. a future
 * `/devtoberfest-2027/`) requires a code change to `CTA_TARGETS` above
 * to appear in the admin value-help — it is not derived from any
 * runtime registry.
 *
 * Used by the AdminService.AlertCtaTargets READ handler.
 */
export function listCtaTargets() {
  return CTA_TARGETS.map(t => ({ url: t.url, label: t.label }));
}
