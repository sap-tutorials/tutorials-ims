## Why

Readers plan their time and decide what to skip, but tutorials only expose one total `time:` in frontmatter. Authors can't say "this step takes 10 minutes" or "this step is optional if you already have an account", so readers either skim and miss things or abandon long tutorials. Inside a step, multi-part tasks ("create subaccount, enable entitlement, assign role") are written as bullet lists that readers can't tick off, so they lose their place after switching to the BTP cockpit and back.

## What Changes

- **Per-step metadata on step headings**: `### Deploy the app {time=5m optional}`.
  - `time` (`5m`, `90s`, `1h`, `1h30m`) renders a per-step time chip and powers a "≈ N min remaining" indicator.
  - `optional` renders an "Optional" badge; optional steps do not block tutorial completion or mission/group rollups; the reader can "Skip" them.
  - The `{…}` is stripped from the step title and slug — anchors, `osOverrides` keys and progress records are unchanged.
  - Lint warns when the sum of step times differs from frontmatter `time:` by >25%; if no frontmatter `time:` is given, it's derived.
- **Interactive checklists**: GFM task list items (`- [ ] Create a subaccount`) inside a step render as accessible checkboxes with persisted per-reader state and a "2/5" counter. `- [x]` items render as pre-checked. When all items in a step are checked, the step's "Done" button is highlighted (never auto-marked).

## Capabilities

### New Capabilities
- `tutorial-step-pacing`: per-step time and optional metadata, and interactive persisted checklists inside steps.

### Modified Capabilities
<!-- none -->

## Impact

- `scripts/parsers/v2.ts` (heading attribute extraction), `scripts/parsers/types.ts` (`TutorialStep.timeSeconds`, `optional`), step frontmatter rendering, `hugo/layouts/shortcodes/tutorial-step.html` / tutorial layouts (chip, badge, skip).
- Progress backend: completion logic treats optional steps as not required (`srv/` completion endpoint + `srv/lib/completion-rollup.js`); step `optional` flag published with the tutorial metadata.
- Client: `hugo/assets/js/tutorial.ts` (remaining-time indicator, skip), new `hugo/assets/js/task-lists.ts`.
- MCP `get_tutorial_step` output includes step time/optional; checklists remain GFM task lists in plain text.
- No dependency on `tutorial-directive-grammar`.
