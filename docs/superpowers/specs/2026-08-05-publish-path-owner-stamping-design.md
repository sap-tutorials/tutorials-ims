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

In the per-slug loop of `linkTutorialAuthorship` (`srv/lib/content-publish-session.js`, alongside the existing `ownerEmail` write at `~line 1018`), add an `owner` write governed by the **"overwrite on strong signal, skip admin edits"** policy (Tom's decision):

```js
// Set TutorialMeta.owner from the declared-author display name (frontmatter
// author_name). "Overwrite on strong signal, skip admin edits":
//   - only write when frontmatter carries a usable author_name (strong signal);
//   - overwrite an existing owner ONLY when the row was NOT last edited by a
//     human admin — detected via modifiedBy: the publish path runs under a
//     system identity, /admin-ui edits stamp the admin's JWT identity.
const fmAuthorName = (typeof meta.frontmatterAuthorName === 'string' && meta.frontmatterAuthorName.trim())
  ? meta.frontmatterAuthorName.trim() : null;
if (fmAuthorName) {
  // Overwrite unless a human admin last touched this row. PUBLISH_IDENTITIES =
  // the set of non-human modifiedBy values the pipeline itself writes
  // (publish/system/anonymous/migration-script labels).
  await db.run(
    `UPDATE ${tutorialMetaTable} SET "OWNER" = ? WHERE "TUTORIAL_ID" = ?
       AND ("MODIFIEDBY" IS NULL OR "MODIFIEDBY" IN (${PUBLISH_IDENTITIES_PLACEHOLDERS}))`,
    [fmAuthorName, tutorialId, ...PUBLISH_IDENTITIES]
  );
}
```

The exact `PUBLISH_IDENTITIES` set is derived from what the publish/pipeline path actually stamps as `modifiedBy` (confirm at implementation: the CAP managed aspect under the publish request context, plus historical bulk labels like `anonymous` and the `scripts/*` initiators). If the set can't be pinned confidently, fall back to fill-NULL-only for `owner` (the safe subset) and log the skipped overwrites for review.

### Write-policy rationale (Tom's decision: "overwrite on strong signal, skip admin edits")

- **Strong signal only:** never blank an owner from a missing/empty `author_name`.
- **Overwrite** keeps owner in sync with the declared author on every publish (fixes migrated mis-attributions like the Achim→Matthäus case automatically on the next content rebuild).
- **Skip admin edits** preserves deliberate `/admin-ui` owner corrections.

### Known limitation (documented, accepted)

`modifiedBy` is **row-level, not field-level**. If an admin edits any other field on a `TutorialMeta` row (e.g. `monitoredStatus`), that row's `modifiedBy` becomes the admin, and the publish path will then skip overwriting `owner` even though the admin never touched `owner` — a false-skip. This errs toward preserving human edits (the safe direction). A field-level fix (an `ownerManuallySet` boolean set only by the admin owner-edit handler) is deliberately out of scope: it needs a schema migration + admin-handler wiring, disproportionate to the benefit. Revisit if false-skips prove common.

## Shared-helper note

The one-shot script's `normalizeName`/`extractGithubLogin` are NOT needed here: this change stamps the raw `author_name` verbatim into `owner` (a display string — no matching), and the author resolution for `ownerEmail`/`author_ID` already exists in `resolve-tutorial-author.js`. No helper extraction required. (If a future change wants name→Users matching in the publish path too, extract those helpers into `srv/lib/` then — not now.)

## Testing

- **Unit** (`test/unit/`, in-memory SQLite): a publish payload with `frontmatterAuthorName` set stamps `TutorialMeta.owner`; overwrites a system-owned row; skips a row whose `modifiedBy` is a human admin; no-ops on empty `author_name`. Model on existing `linkTutorialAuthorship` unit coverage.
- **Hybrid** (`test/hybrid/`, real HANA): publish a seeded tutorial, assert `owner` is set from frontmatter; re-publish after an admin edit, assert owner is preserved.
- **Regression:** confirm the existing `author_ID`/`ownerEmail`/`githubLogin` writes are unchanged (same test file).

## Rollout

- Branch off fresh `origin/main`; PR; code review (touches the core publish path).
- srv + scripts change → standard deploy; MTA patch bump.
- After deploy, a content rebuild (`rebuild-content.yml`, mode=full) will stamp `owner` across all tutorials via the normal pipeline — converging on the same state the one-shot script produced, then keeping it fresh.
- The one-shot reconciliation script remains for out-of-band correction but is no longer the only path.
