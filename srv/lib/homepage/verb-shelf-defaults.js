// srv/lib/homepage/verb-shelf-defaults.js
//
// (#1089) Single source of truth for the VerbDefinitions and ShelfDefinitions
// runtime auto-init defaults. Extracted from srv/admin-service.js so tests can
// derive expected row counts / keys from the same data the auto-init handler
// inserts.
//
// Values MUST agree with:
//   - db/data/com.sap.developers.ims-VerbDefinitions.csv
//   - db/data/com.sap.developers.ims-ShelfDefinitions.csv
//
// Callers:
//   - srv/admin-service.js   (before-READ auto-init on empty tables)
//   - test/{unit,hybrid,smoke} test-count derivations — see issue #1089

export const VERB_DEFAULTS = Object.freeze([
  { verbKey: 'LEARN',     label: 'Learn',          iconName: 'learning-assistant',    sortOrder: 10 },
  { verbKey: 'BUILD',     label: 'Build',          iconName: 'developer-settings',    sortOrder: 20 },
  { verbKey: 'INTEGRATE', label: 'Integrate',      iconName: 'chain-link',            sortOrder: 30 },
  { verbKey: 'MODEL',     label: 'Model',          iconName: 'database',              sortOrder: 35 },
  { verbKey: 'OPERATE',   label: 'Operate',        iconName: 'settings',              sortOrder: 40 },
  { verbKey: 'AI',        label: 'Extend with AI', iconName: 'da',                    sortOrder: 50 },
  { verbKey: 'CONNECT',   label: 'Connect',        iconName: 'customer-and-contacts', sortOrder: 60 },
]);

export const SHELF_DEFAULTS = Object.freeze([
  { shelfKey: 'START_HERE',   label: 'Start here',      iconName: 'learning-assistant', sortOrder: 10 },
  { shelfKey: 'REFERENCE',    label: 'Reference',       iconName: 'document',           sortOrder: 20 },
  { shelfKey: 'TOOLS',        label: 'Tools & samples', iconName: 'wrench',             sortOrder: 30 },
  { shelfKey: 'KEEP_CURRENT', label: 'Keep current',    iconName: 'newspaper',          sortOrder: 40 },
]);

// Convenience derived exports — used by tests that spot-check keys.
// Frozen; sorted for determinism (the order-sensitive contract lives in
// VERB_DEFAULTS.map(d => d.verbKey), which follows sortOrder ascending).
export const VERB_KEYS_SORTED  = Object.freeze([...VERB_DEFAULTS.map((d) => d.verbKey)].sort());
export const SHELF_KEYS_SORTED = Object.freeze([...SHELF_DEFAULTS.map((d) => d.shelfKey)].sort());
