# Mission Renderer Direct-Tutorial Support — Design Spec

**Status:** Draft for review
**Date:** 2026-06-19
**Author:** Tom Jung (with Claude)
**Related:** #382 phase F1; surfaced after PR #423 (bulk-SQL recompute) when the meta-tutorials mission was created via admin UI

## Summary

`srv/lib/catalog-data.js` `loadMissionContext()` queries `CompletionPathItems` with `taskType: 'GROUP'` only — direct `taskType: 'TUTORIAL'` items in a CompletionPath are silently dropped. This means missions whose paths point at tutorials directly (without an intermediate Group wrapper) render an empty "Groups in this Mission" section. This spec extends the loader and renderer to support direct-tutorial paths by synthesizing a virtual group from the path itself, mirroring the contract `srv/lib/build-catalog.js` already implements for the navigator JSON.

## Goals

1. **Parity with `build-catalog.js`.** The mission SSR page and the navigator JSON should show the same grouping/tutorial shape for any given mission. Today the navigator handles direct-tutorial paths (`build-catalog.js:91-117`); the SSR doesn't. Drift is wrong.
2. **Backward compatible.** Existing missions with the AEM-era "Mission → Path → Group → Tutorial" shape render identically. Only missions with `CompletionPathItems.taskType='TUTORIAL'` rows gain new behavior.
3. **No schema change.** Pure code fix. Path-as-synthetic-group is computed at render time, not stored.
4. **No "View Group →" 404 trap.** A synthetic group must NOT render a "View Group →" link, since there's no Group page to navigate to.

## Non-Goals

- Refactoring `build-catalog.js` and `loadMissionContext` to share a helper. Worth doing eventually but out of scope here; the immediate fix is making the contracts match by hand-mirroring the logic.
- Changing the admin UI to enforce one shape over the other. Both shapes are valid in the schema and v1 IMS supported both. The renderer was the gap.
- Group-side changes. `loadGroupContext` is unchanged.

## Approach

**Mirror `build-catalog.js:91-117` exactly** in `loadMissionContext`. Extend `renderMissionBody` to render a "synthetic group" card without the "View Group →" link or anchor on the title.

### `loadMissionContext` changes

Today (line 119-124):

```js
const items = pathIds.length
  ? await SELECT.from(CompletionPathItems)
      .where({ path_ID: { in: pathIds }, taskType: 'GROUP', group_ID: { '!=': null } })
      .columns('group_ID', 'itemOrder', 'path_ID')
      .orderBy('path_ID', 'itemOrder')
  : [];
```

After:

```js
// Fetch BOTH taskType variants. Direct TUTORIAL items become synthetic
// path-groups; nested GROUP items resolve through the Groups table.
const items = pathIds.length
  ? await SELECT.from(CompletionPathItems)
      .where({ path_ID: { in: pathIds } })
      .columns('group_ID', 'tutorial_ID', 'taskType', 'itemOrder', 'path_ID')
      .orderBy('path_ID', 'itemOrder')
  : [];
```

Then build the `groupCards` array in two passes per path:

1. **Synthetic path-group:** if the path has any `taskType='TUTORIAL'` items, emit one synthetic group with `slug = path.slug`, `title = path.name`, `tutorials = [...]` resolved through the Tutorials table. Mark it with a `isSynthetic: true` flag so the renderer can branch on it. **Order matches `build-catalog.js`: synthetic group first, then nested groups.**
2. **Nested groups:** existing logic for `taskType='GROUP'` items.

### `renderMissionBody` changes

Conditional rendering of the title anchor and "View Group →" link based on `g.isSynthetic`:

```js
// Title: anchor when real Group, plain h3 when synthetic
${g.isSynthetic
  ? `<h3>${escapeHtml(g.title)}</h3>`
  : `<h3><a href="/tutorials/group-${escapeHtml(g.slug)}" onclick="event.stopPropagation()">${escapeHtml(g.title)}</a></h3>`
}
...
// "View Group →" link only when real Group
${g.isSynthetic ? '' : `<a href="/tutorials/group-${escapeHtml(g.slug)}" class="group-start-link">View Group &rarr;</a>`}
```

### Tutorial resolution helper

Both the synthetic-group path (Tutorials.ID via `tutorial_ID`) and the nested-group path (Tutorials.ID via `GroupPathItems.tutorial_ID`) need the Tutorials table. Combine the lookups:

```js
const directTutorialIds = items
  .filter(i => i.taskType === 'TUTORIAL' && i.tutorial_ID)
  .map(i => i.tutorial_ID);
const nestedTutorialIds = gpiRows.map(r => r.tutorial_ID).filter(Boolean);
const allTutorialIds = [...new Set([...directTutorialIds, ...nestedTutorialIds])];
const tutorials = allTutorialIds.length
  ? await SELECT.from(Tutorials).where({ ID: { in: allTutorialIds }, ... })
  : [];
```

## Test strategy

### Unit tests (SQLite, vitest)

New tests in `test/catalog-data-mission-direct-tutorials.test.js`:

1. **Mission with only direct-TUTORIAL path items** → 1 synthetic group, all tutorials, isSynthetic=true. (The case that broke #382.)
2. **Mission with only GROUP path items (existing behavior)** → groups[] populated as before, no synthetic. **Regression check.**
3. **Mission with mixed direct + GROUP path items** → synthetic first, then nested groups.
4. **Path with no name** (NULL or empty) → synthetic group title falls back to slug or some safe default.
5. **Synthetic group is not given an externally-resolvable slug** in the rendered output — i.e. clicking the title doesn't 404. (This is a renderer test in catalog-renderer.)

### Renderer tests in `test/catalog-renderer.test.js`

If existing tests exist for `renderMissionBody`:
- Add: synthetic group renders title as plain `<h3>` (no anchor)
- Add: synthetic group renders no "View Group →" link
- Verify: existing tests for non-synthetic groups still pass

### Hybrid test — not needed

The change is purely query-shape + rendering. No HANA-specific behavior. SQLite tests cover all the relevant code paths.

### Live deploy validation

Same as #382 phase E acceptance: `/tutorials/mission-tutorial-platform-features-for-authors` should render with all 4 tutorials listed under "New 2.0 Features" group card.

## Risks and open questions

1. **Group slug collision.** If a CompletionPath happens to have a slug identical to a real Group's slug, `/tutorials/group-<slug>` would route to the real Group, not the path. Today this is impossible because the synthetic path-group doesn't have a "View Group →" link (the slug is only used internally for keying). No collision in practice.
2. **`build-catalog.js` line 117 emits `[pathGroup, ...nestedGroups]`** — the synthetic group always comes BEFORE nested groups. Mission renderer must match this ordering for parity.
3. **`loadMissionContext` returns `groupCount` and `tutorialCount`** for the mission-meta header (line 167-168). Both need to count synthetic + nested correctly. The existing `groupCards.length` and `allTutorials.length` math still works since both shapes flow through the same final array.
4. **Path slug NULL.** Our test case had `slug: 'new-2-0-features'` after the manual repair. But existing missions from the v1 IMS migration might have NULL path slugs. The synthetic group uses `path.slug || String(path.legacyId)` (matching build-catalog.js line 113) — handles both.

## Files

| File | Change | LoC delta |
|------|--------|-----------|
| `srv/lib/catalog-data.js` | Extend `loadMissionContext` for direct TUTORIAL items | +30 |
| `srv/lib/catalog-renderer.js` | Conditional rendering for `isSynthetic` groups | +6 |
| `test/catalog-data-mission-direct-tutorials.test.js` | New unit tests (5 cases) | +120 (new file) |
| `test/catalog-renderer.test.js` | Renderer assertions for synthetic groups | +20 if file exists, +60 if new |

## References

- Surfaced by: #382 phase F1 mission "Tutorial Platform Features for Authors"
- Reference implementation: [`srv/lib/build-catalog.js:91-117`](../../../srv/lib/build-catalog.js#L91-L117)
- Affected file: [`srv/lib/catalog-data.js:101-172`](../../../srv/lib/catalog-data.js#L101-L172)
- Renderer: [`srv/lib/catalog-renderer.js:123-194`](../../../srv/lib/catalog-renderer.js#L123-L194)
