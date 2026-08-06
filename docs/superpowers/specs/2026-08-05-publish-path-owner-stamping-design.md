# Publish-path owner stamping (issue #1501)

**Date:** 2026-08-05
**Issue:** [#1501](https://github.com/sap-tutorials/tutorials-ims/issues/1501)
**Status:** design

## Context

`TutorialMeta.owner` (the free-text display name shown in the Admin UI "Owner" column and used by the SAGE priority-4 ownership join) is **not set by the content publish path**. `upsertTutorialMetadata` inserts new meta rows with `owner: null` and never stamps it; `linkTutorialAuthorship` resolves the declared author and writes `Tutorials.author_ID`, `TutorialMeta.ownerEmail`, and seeds `Users.githubLogin` — but never `TutorialMeta.owner`.

Consequence: every newly-published tutorial has a blank owner, and edited tutorials keep whatever (possibly wrong/migrated) owner they had. This is the drift that required the one-shot `scripts/reconcile-tutorial-owner-from-frontmatter.cjs` (#1498/#1499/#1500) to be run manually against prod during the 2026-08 author-ownership incident (Matthäus Schüle: 6 tutorials in IMS, 1 in Admin UI). This change makes owner stamping continuous so the manual script becomes maintenance-only, not the sole source of correct owner data.

## Goal

On every publish/update, set `TutorialMeta.owner` from the tutorial's frontmatter `author_name` (the declared-author display name), so the Admin UI owner column and name-based SAGE join stay correct without an out-of-band script.

Non-goals: `author_ID`, `ownerEmail`, and `githubLogin` writes already exist and are unchanged. This adds exactly the missing `owner` write.

## Approach

`linkTutorialAuthorship` in `srv/lib/content-publish-session.js` already runs per-slug on every publish and has the resolved author in hand. Add the `owner` write there, sourced from a new payload field.

### Change 1 — carry `author_name` into the publish payload

`scripts/publish-content.ts` reads the built page frontmatter (`~line 400-438`) but does not extract `fm.author`. The built Hugo page emits `author:` (the display name) via `render-frontmatter.ts`. Add:

```ts
// in the TutorialMeta payload type (~line 388)
frontmatterAuthorName: string | null;
// in the result object (~line 435)
frontmatterAuthorName: trim(fm.author),
```

### Change 2 — write `TutorialMeta.owner` in `linkTutorialAuthorship`

In the per-slug loop of `linkTutorialAuthorship` (`srv/lib/content-publish-session.js`, alongside the existing `ownerEmail` write at `~line 1018`), add an `owner` write using the **overwrite-on-strong-signal** policy — the SAME "frontmatter wins" rule the sibling `author_ID` write already uses on this path (`~line 966`), via raw `db.run()` to match:

```js
// Set TutorialMeta.owner from the declared-author display name (frontmatter
// author_name). Overwrite on strong signal: whenever frontmatter carries a
// usable author_name, it wins — identical policy to Tutorials.author_ID above
// (both derive from the same declared-author frontmatter signal, so they stay
// consistent). Never blanks owner from a missing/empty author_name.
const fmAuthorName = (typeof meta.frontmatterAuthorName === 'string' && meta.frontmatterAuthorName.trim())
  ? meta.frontmatterAuthorName.trim() : null;
if (fmAuthorName) {
  const res = await db.run(
    `UPDATE ${tutorialMetaTable} SET "OWNER" = ? WHERE "TUTORIAL_ID" = ?`,
    [fmAuthorName, tutorialId]
  );
  if (res && (typeof res === 'number' ? res : 1) > 0) linkedOwners++;
}
```

### Write-policy rationale (Tom's decision: "overwrite unconditionally, like author_ID")

- **Strong signal only:** never blank an owner from a missing/empty `author_name`.
- **Overwrite unconditionally:** whenever frontmatter has an author_name, it wins — matching the existing `Tutorials.author_ID` policy on the same code path. `owner` and `author_ID` derive from the same declared-author signal, so a single consistent rule keeps them in lock-step and self-heals migrated mis-attributions (e.g. Achim→Matthäus) on the next content rebuild.
- **Trade-off (accepted):** a manual `/admin-ui` owner correction is reverted on the next publish/rebuild of that tutorial. Acceptable because `owner` is defined as "the declared author," which the frontmatter is the source of truth for; deliberate owner reassignment belongs in the tutorial's frontmatter, not a transient admin edit.

### Why not `modifiedBy`-based admin-edit skipping (rejected during planning)

An earlier design draft proposed skipping overwrite when `modifiedBy` indicated a human admin. This does NOT work reliably: the publish path writes via raw `db.run()`, which bypasses CAP's managed `modifiedBy` stamping, so publish never refreshes `modifiedBy`. Historical `modifiedBy` values on prod are dominated by bulk-write residue (`thomas.jung@sap.com` on 1,410 rows from the resync, `anonymous` on 268) that are indistinguishable from genuine admin edits — the same ambiguity that complicated the reconciliation script. A precise field-level `ownerManuallySet` flag would work but needs a schema migration + admin-handler wiring, disproportionate to the benefit. Overwrite-unconditionally sidesteps all of it.

## Shared-helper note

The one-shot script's `normalizeName`/`extractGithubLogin` are NOT needed here: this change stamps the raw `author_name` verbatim into `owner` (a display string — no matching), and the author resolution for `ownerEmail`/`author_ID` already exists in `resolve-tutorial-author.js`. No helper extraction required. (If a future change wants name→Users matching in the publish path too, extract those helpers into `srv/lib/` then — not now.)

## Testing

- **Unit** (`test/unit/`, in-memory SQLite): a publish payload with `frontmatterAuthorName` set stamps `TutorialMeta.owner`; overwrites an existing (different) owner value; no-ops on empty/missing `author_name` (never blanks). Model on existing `linkTutorialAuthorship` unit coverage.
- **Hybrid** (`test/hybrid/`, real HANA): publish a seeded tutorial, assert `owner` is set from frontmatter; change the seeded frontmatter author and re-publish, assert `owner` follows (overwrite).
- **Regression:** confirm the existing `author_ID`/`ownerEmail`/`githubLogin` writes are unchanged (same test file).

## Rollout

- Branch off fresh `origin/main`; PR; code review (touches the core publish path).
- srv + scripts change → standard deploy; MTA patch bump.
- After deploy, a content rebuild (`rebuild-content.yml`, mode=full) will stamp `owner` across all tutorials via the normal pipeline — converging on the same state the one-shot script produced, then keeping it fresh.
- The one-shot reconciliation script remains for out-of-band correction but is no longer the only path.
