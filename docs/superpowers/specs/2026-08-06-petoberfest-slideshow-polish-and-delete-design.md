# Petoberfest — Slideshow polish + admin delete

**Date:** 2026-08-06
**Status:** Approved (design)
**Scope:** Public Petoberfest slideshow UI + Admin UI permanent-delete of submissions

## Problem

The public Petoberfest page (`/petoberfest/petoberfest-2026/`) has two UX problems and the
admin surface is missing a capability:

1. **Input area jumps** — the slideshow `<img>` renders at each photo's natural height and
   the upload form sits directly below it in normal document flow. Slides with different
   aspect ratios reflow the whole page as the show advances.
2. **No "chrome"** — the island ships with *no* CSS (unlike the 38 other islands that use
   scoped `<style>` blocks), so the image and controls look rough and unstyled.
3. **No pause** — the show auto-advances every 5s with no way to pause/resume or step.
4. **No permanent delete** — once a submission is hidden it still lives in the DB (image
   BLOBs included). There is no way to purge test uploads. Admins need this from the
   existing Admin UI, single- and multi-row.

## Part 1 — Public slideshow (`hugo-apps/src/petoberfest/App.vue`)

### Fixed-height stage (kills the jump)

Wrap the image in a fixed-aspect stage (`aspect-ratio: 16 / 10`, `max-height` capped for
tall viewports). The image uses `object-fit: contain` centered in the stage → letterboxed,
never taller than the stage. Because the stage height is constant, the upload form below
never reflows regardless of image dimensions. This is the root-cause fix for the jump and
is independent of any theming.

### Festive framing ("Playful Petoberfest theme")

- Paw-motif title band above the stage: `🐾 Petoberfest 2026 🐾` (title from event data if
  available, else static).
- Warm autumn palette, rounded "polaroid"-style card with a soft shadow around the stage.
- Caption plate inside the frame: `"<petName>" — <uploaderName>` (falls back to "A good
  pet" / omits uploader when absent, preserving current behavior).
- Empty state (`No pets yet — be the first! 🐾`) restyled to match.

### Controls (Pause/resume + prev/next + dots)

Overlaid on / beneath the stage:

- ◀ prev / ▶ next arrow buttons.
- ⏸ / ▶ play-pause toggle.
- Clickable progress dots (● ○ ○) — click jumps to that slide.

**Behavior:**

- A `paused` ref (default `false`, i.e. auto-plays as today).
- The 5s `setInterval` stays installed but only advances when `!paused` and
  `slides.length > 1`.
- Manual prev/next/dot works whether paused or playing. When playing, a manual nav resets
  the interval timer (clear + re-set) so the next auto-advance is a full interval away —
  avoids an immediate jump right after a manual step.
- The play-pause toggle flips `paused`.
- `onUnmounted` still clears the timer.

All styling lives in a scoped `<style>` block on `App.vue` (island convention; no global
CSS file exists for this island). Accessibility: control buttons get `aria-label`s; the
stage image keeps its `:alt`.

**No backend changes for Part 1.** `fetchSlideshow`, `photoUrl`, `probeAuth`,
`fetchMyUploads`, `uploadPet` are unchanged.

## Part 2 — Admin permanent delete

**Semantics:** delete is permitted only on submissions whose `moderation === 'HIDDEN'`
(Hide-first, then Delete). Available single-row (object page) and multi-row (list report
overview, which already uses `ForceMulti` selection).

### Backend

- New bound action on `AdminService.PetSubmissions` in `srv/admin-service.cds`:

  ```cds
  @(requires: ['Tutorial.Author', 'Admin'])
  action purge();
  ```

  Same gate as `approve`/`hide`.

- Handler in `srv/admin-service.js` (next to the existing `approve`/`hide` handlers,
  mirroring the `req.params?.[0]?.ID ?? req.params?.[0]` key pattern):

  - Resolve `id`; reject 400 if missing.
  - SELECT the row's `moderation`; if not `'HIDDEN'`, reject 400
    ("Only hidden submissions can be deleted — hide it first.").
  - `DELETE.from(PetSubmissions).where({ ID: id })`. Because `photoDisplay`/`photoThumb`
    are columns on the row, the DELETE purges the image bytes too — a true DB cleanup.
  - `req.reply()`.

- Keep `Capabilities.DeleteRestrictions.Deletable: false` — delete goes through the guarded
  action, not native OData DELETE (native DELETE can't enforce the HIDDEN guard cleanly and
  wouldn't give a labeled toolbar button).

### Annotations (`app/admin-annotations.cds`)

Add to the `PetSubmissions` `UI.LineItem` and `UI.Identification` arrays:

```cds
{ $Type: 'UI.DataFieldForAction', Action: 'AdminService.purge', Label: 'Delete' }
```

FE renders it as a toolbar button in the LR (operates per selected row → multi-delete is
automatic) and on the object page. Mark it critical/destructive where FE supports it
(`![@UI.Emphasized]` / `Criticality`) so it reads as a dangerous action; FE's built-in
bulk-action confirm covers accidental clicks, and the server-side HIDDEN guard is the hard
safety net.

### Testing

Extend `test/unit/petoberfest-admin.test.js`:

- `purge` succeeds on a HIDDEN row and the row (and thus its BLOBs) is gone afterward.
- `purge` rejects (400) on PENDING and on APPROVED rows.
- `purge` rejects (400) when key is missing.

## Out of scope

- No changes to upload validation, scoring, NGDS auto-send, or the public
  `PetoberfestService`.
- No new env vars or DB migration (the action reuses the existing table/columns).
- No change to who can moderate (same XSUAA scopes).

## Files touched

- `hugo-apps/src/petoberfest/App.vue` — stage, framing, controls, scoped styles.
- `srv/admin-service.cds` — `purge` action declaration.
- `srv/admin-service.js` — `purge` handler with HIDDEN guard.
- `app/admin-annotations.cds` — Delete `DataFieldForAction` in LineItem + Identification.
- `test/unit/petoberfest-admin.test.js` — purge tests.
- `app/admin/petoberfest/webapp/manifest.json` — bump `applicationVersion` (FE fragment/
  annotation cache bust, per admin-ui5-fragment-cache gotcha).
