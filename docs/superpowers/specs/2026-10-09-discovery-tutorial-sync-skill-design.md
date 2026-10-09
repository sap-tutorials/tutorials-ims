# Design: `sap-discovery-tutorial-sync` Skill

**Date:** 2026-10-09
**Status:** Approved design, ready for implementation plan
**Author:** Tom (design via Claude Code brainstorming)

---

## 1. Problem

Several SAP teams maintain the same tutorials in **two** places:

1. **SAP Discovery Center format** — e.g. [`SAP-samples/btp-developer-guide-cap/documentation/tutorials`](https://github.com/SAP-samples/btp-developer-guide-cap/tree/main/documentation/tutorials). Plain markdown, no frontmatter, `<details>`-based variants, Discovery-Center layout comments.
2. **sap-tutorials platform format** — e.g. [`sap-tutorials/btp-dev-guidance/tutorials`](https://github.com/sap-tutorials/btp-dev-guidance/blob/main/tutorials/). Our enriched v2-parser format: required YAML frontmatter, `[OPTION BEGIN …]` variants, slug-named image folders, optional `rules.vr` quizzes.

Maintaining both by hand is friction, so teams want to drop their sap-tutorials copy. **Goal:** make syncing *their* Discovery Center source into *our* format so cheap and foolproof that they'll keep both current — the skill does the mechanical conversion, validates against our real build, and preserves our platform-specific enrichments on update.

### Source → target format gap

| Aspect | Discovery Center (SAP-samples) | Our platform (sap-tutorials) |
|---|---|---|
| Frontmatter | **None** | Required YAML: `parser`, `primary_tag`, `tags`, `time`, author, optional `video` |
| Title | `## H2` (first heading) | `# H1` + `<!-- description -->` line |
| Steps | `### H3` under H2 sections | `### H3` — one H3 == one step |
| Variants | `<details [open]><summary>Node.js</summary>…</details>` | `[OPTION BEGIN [Node.js]]…[OPTION END]` tab strip |
| OS variants | ad-hoc `<details>` | OS-conditional OPTION blocks → global OS picker (§3.5.2 of writing-tutorials.md) |
| Images | `![x](./img.png)` + `<!-- border; size:540px -->` layout comments | `![x](img.png)` in a slug-named folder, no layout comment |
| Callouts | `>` and `> [!NOTE]` | identical — pass through |
| Quiz/validation | none | `rules.vr` in the parallel `<repo>-Contribution` repo |

Folder names are **stable and identical** across both repos (both use kebab-case `build-cap-app`, `add-authorization`, …), so the slug mapping is 1:1 with no translation needed.

---

## 2. Scope

**In scope:** a Claude Code skill that converts one tutorial (by slug) from Discovery Center source into our format, validates it, and optionally opens a PR. Both new-import and update-of-existing paths.

**Out of scope (YAGNI):** bulk "sync the whole repo" in one shot (the skill operates per-slug; a human can loop it); authoring brand-new content; changing the fetch/Hugo/HANA pipeline; the reverse direction (our format → Discovery Center).

---

## 3. Shape

A skill directory matching the convention of the existing `sap-tutorial-dual-pr` and `tutorial-qa-to-prod` skills:

```
sap-discovery-tutorial-sync/
  SKILL.md                     # the procedure Claude follows (judgment lives here)
  scripts/
    convert-body.mjs           # deterministic mechanical transforms (run with `node -I`)
  references/
    format-mapping.md          # the full mapping table + edge cases
    taxonomy-check.md          # how to resolve + validate tags
```

**Division of labor** — the hard parts (frontmatter inference, 3-way merge judgment, variant-label normalization, description wording) need Claude's reasoning and live in SKILL.md as an explicit procedure. The deterministic, error-prone mechanical bits (HTML→OPTION regex, image-path rewrite, layout-comment stripping, YAML lint) live in `convert-body.mjs` so they're repeatable and testable.

**Trigger phrases:** "sync/import/update the Discovery Center version of `<slug>`", "copy the `btp-developer-guide-cap` tutorial over", "pull the SAP-samples version of `<tutorial>` into our repo".

---

## 4. Flow (two-phase)

### Phase A — Draft locally (always)

1. **Resolve slug → source.** Fetch the source `.md` and all referenced images from the SAP-samples repo (default `SAP-samples/btp-developer-guide-cap`, path `documentation/tutorials/<slug>/<slug>.md`; the source repo + path are skill parameters so other teams' repos work too). Record the source commit SHA.
2. **Detect mode.** New import vs update — does `sap-tutorials/<repo>/tutorials/<slug>.md` already exist (check the local checkout, else GitHub)?
3. **Convert body** via `convert-body.mjs` (§5).
4. **Frontmatter** — prompt the author for every required field (§6). On update, existing values are the defaults.
5. **rules.vr** — prompt per tutorial (§8).
6. **If update:** 3-way merge, show diff, STOP for approval before writing (§7).
7. **Write** the draft into a local working dir (`.sync-draft/<slug>/`): the converted `.md`, the slug-named image folder, and the `rules.vr` (under the `-Contribution` path).
8. **Validate** with the real parser (§9).
9. **Report** — files written, validation verdict, every AI-inferred/unverified field flagged, what to review.

**── STOP. Human reviews the draft. ──**

### Phase B — Open PR (only on explicit confirmation)

10. `git fetch origin`; branch from fresh `origin/main` of `sap-tutorials/btp-dev-guidance` (never a stale local main).
11. Copy draft into place, commit, `gh pr create`.
12. PR body cross-links the SAP-samples source commit, lists inferred fields to review, and notes it was generated by the sync skill. **Never direct-merge; never push to main.** rules.vr changes go to the `-Contribution` repo PR, cross-linked.

---

## 5. Conversion engine (`convert-body.mjs`)

Pure, deterministic, no network. Input: source markdown string + slug. Output: converted body + a list of items needing human judgment.

| Transform | Rule |
|---|---|
| First `## Title` → `# Title` | Promote the first H2 to H1; emit a `<!-- description -->` placeholder line for Claude to fill. |
| `<details [open]><summary>LABEL</summary>…</details>` → OPTION block | `[OPTION BEGIN [LABEL]]` … `[OPTION END]`. `open` attribute dropped (first tab is default). |
| Image paths | `![alt](./img.png)` → `![alt](img.png)`; strip `<!-- border; size:… -->` layout comments. |
| `### Section` | Pass through as a step. If an H2 section wraps multiple H3s, keep H3s as steps and drop the wrapper H2 (flag it). |
| Callouts `>` / `> [!…]` | Pass through unchanged (format-compatible). |
| Code fences | Pass through; report any fence missing a language tag for Claude to backfill. |

**Label normalization** (Claude, post-script): `Node.js`/`Java` → generic OPTION tabs. Labels matching the OS table (`Windows`/`Win`, `macOS`/`Mac`, `Linux`/`Ubuntu`, `BAS`) → recognized OS-conditional labels so the global OS picker wires up automatically. Combined labels (`Mac and Linux`) preserved verbatim.

**Edge cases flagged, never auto-handled:**
- **Nested `<details>`** (variant within variant) — OPTION blocks don't nest cleanly; flag for human.
- Unbalanced/malformed `<details>` — flag, don't guess.
- H4/H5 inside a step — they won't render as nav; flag.

**Images:** every image referenced in the converted body is fetched into `.sync-draft/<slug>/<slug>/`. The validator (§9) asserts each referenced image exists on disk — this guards the most common build failure.

---

## 6. Frontmatter (always-prompt + taxonomy gate)

Collected interactively before any write:

| Field | Behavior |
|---|---|
| `parser: v2` | Always set, never asked. |
| `primary_tag` | **Hard gate.** Resolve the live taxonomy (local `db/data/*Tags*.csv`, else `Tags` entity via cds-mcp against the running CAP service). Present valid options; reject any value not in the taxonomy. |
| `tags` | Array. Enforce element 0 is a level tag (`tutorial>beginner|intermediate|advanced`); validate the rest against the taxonomy. |
| `time` | Integer minutes. Skill suggests an estimate from step count/length; author confirms. |
| `author_name` / `author_profile` | Prompted; on update, carried forward from our existing version (not re-asked). |
| `video` | If source has an intro YouTube/Vimeo/openSAP iframe or link, offer to lift it into `video:` frontmatter (host must be on the platform allowlist). |
| `auto_validation` | Set `true` iff a quiz exists after §8 — not asked directly. |

**Update:** existing frontmatter values are per-field defaults — author confirms/overrides, never re-enters from scratch.

**Taxonomy-unavailable fallback:** if neither CSV nor cds-mcp is reachable, warn, let the author type values, and tag each with `# UNVERIFIED TAG` in the review note rather than silently trusting it.

---

## 7. Update merge (diff + preserve ours)

A `.sync-manifest.json` in the working area records, per slug, the **source commit SHA last synced**.

- **base** = source body at the last-synced SHA (if recorded).
- **theirs** = current source body.
- **ours** = our current `.md`.

3-way merge: take upstream **body** prose/step changes; **preserve** our frontmatter, `rules.vr`, OPTION/OS enrichments, and `<!-- description -->`. Render the unified diff and **STOP** for human approval before writing. First-time import = no base → straight convert, no merge. On successful write, update the manifest SHA.

---

## 8. rules.vr (prompt per tutorial)

The source never has a quiz. Ask:

1. Quiz or not?
2. If yes: `[AUTOAUTHOR_ALL]` skeleton (platform generates questions from step text at build time) **vs** hand-authored `[VALIDATE_N]` stubs **vs** carry-forward our existing `rules.vr` (update case).

Set `auto_validation: true` only when a quiz exists. Write `rules.vr` to the `<repo>-Contribution` path convention (private companion repo), not the public repo — consistent with the platform's quiz-file location and the `tutorial-qa-to-prod` skill.

---

## 9. Validation (run the real parser)

After writing the draft:

1. **Built-in pre-check** (always, no deps): balanced `[OPTION BEGIN]`/`[OPTION END]`, every referenced image exists on disk, frontmatter is valid YAML, exactly one H1, slug is lowercase, `parser: v2` present.
2. **Real parser** (when a local `tutorials-ims` checkout is available): run the repo's `fetch-tutorials` parser dry-run / `npm run validate-tutorials` against the draft and read `.tutorial-cache/errors.json`. A conversion that wouldn't build is caught **before** Phase B.
3. **No checkout:** warn, run built-in checks only, mark the draft **"parser-unverified"** in the report. Never claim it builds without evidence.

Wrap any noisy command in `scripts/quiet-run.sh` per the repo's token-efficiency rule.

---

## 10. Foolproofing summary (the "fairly foolproof" bar)

- Taxonomy hard-gate on `primary_tag`/`tags` — no silent miscategorization.
- Image-existence assertion — guards the #1 build failure.
- Real-parser validation before PR — a non-building conversion never reaches review.
- 3-way merge preserves our enrichments — updates don't clobber frontmatter/quizzes.
- Two-phase with a mandatory review STOP — nothing is pushed un-reviewed.
- Every inferred/unverified value is flagged in the report and PR body.
- Nested/malformed variant blocks are flagged, never silently mangled.
- Follows the org golden rules: `git fetch` before branching, PR not direct-merge, branch from fresh `origin/main`.

---

## 11. Open items for the implementation plan

- Confirm the exact local validator entrypoint (`npm run validate-tutorials` is listed as "partially in place" in writing-tutorials.md §11 — fall back to a `fetch-tutorials --slug <slug>` dry-run if it's not wired).
- Confirm the taxonomy source filename under `db/data/` (the Tags CSV) vs the cds-mcp entity name.
- Decide the working-dir location (`.sync-draft/` in the checkout vs `$CLAUDE_JOB_DIR/tmp`).
- `convert-body.mjs` needs unit tests over fixture pairs (source `<details>` → expected OPTION output, image rewrite, H2→H1).
