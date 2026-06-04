# Browse parity fixtures

These captured Hugo outputs are the source of truth for
`card-template-parity.test.ts` and `BrowsePage.hydration.test.ts`.

## Files

| File | Purpose |
|---|---|
| `cards.fixtures.json` | Canonical input data for both Vue (`renderToString`) and Hugo (`partial` render). |
| `card-tutorial.expected.html` | Captured Hugo output of `partials/browse/_partials/card-tutorial.html` against `cards.fixtures.json#tutorial`. |
| `card-mission.expected.html` | Captured Hugo output of `partials/browse/_partials/card-mission.html` against `cards.fixtures.json#mission`. |
| `card-group.expected.html` | Captured Hugo output of `partials/browse/_partials/card-group.html` against `cards.fixtures.json#group`. |
| `browse-page-1.html` | Captured Hugo output of `layouts/browse/list.html` against a small synthetic `browse.json` (1 mission + 1 group + 1 tutorial). Used by the hydration test. |

## When to regenerate

Whenever you intentionally change card markup (e.g. PR adds a new
field to `TutorialCard.vue` and `card-tutorial.html`, or you tweak
the SVG icon paths). The diff in the captured `.expected.html`
files should match what you changed in the SFC + Hugo partial.

If the parity test fails without an intentional markup change,
**investigate** — the fix is to align the Vue SFC with the Hugo
partial (Hugo is the source of truth for the SSR output), not to
regenerate the fixture to silence the test.

## How to regenerate

```bash
./tools/regen-card-parity-fixtures.sh
```

The script:

1. Builds a tiny standalone Hugo site under `tools/.parity-fixtures/`.
2. Copies the canonical card partials into it and renders each one
   against `cards.fixtures.json`.
3. Captures `browse-page-1.html` by running Hugo against a synthetic
   `hugo/data/browse.json` (cleaned up after the run).
4. Copies the rendered HTML to this directory.

## Why these are committed

Static fixtures are CI-friendly: `vitest` does not need a Hugo binary
on the runner. Drift in the fixture files appears in PR diffs — visible
review surface for any markup change.
