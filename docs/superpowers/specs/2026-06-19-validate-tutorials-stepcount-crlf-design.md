# validate-tutorials stepCount=0 quarantine — design

**Issue:** [#432](https://github.com/sap-tutorials/tutorials-ims/issues/432) — `validate-tutorials.ts`: 30+ tutorials quarantined per publish for "Invalid stepCount value: 0"

**Date:** 2026-06-19

## Problem

The pre-publish validator at [scripts/validate-tutorials.ts:69](../../../scripts/validate-tutorials.ts#L69) is quarantining ~30 tutorials per publish run because their generated Hugo frontmatter has `stepCount: 0`. The quarantine + carry-forward pattern (same as #425) hides the symptom from end users — those tutorials' previous good content keeps serving — but new tutorials with the same flaw silently go missing.

## Investigation summary

Sampled 11 of the named-quarantined tutorials. Three distinct root causes:

| Class | Count in sample | Cause |
|---|---|---|
| **CRLF line endings + `parser: v2`** | 8/11 | `parseV2Steps`'s `/^### (.+)$/` regex fails on `\r`-terminated lines. JavaScript's `$` anchor (without `m` flag) does not match before `\r`, only before `\n` or EOF. Body has valid H3 step headings; parser returns 0 steps; validator quarantines. Verified by tracing through `composeTutorial()` with `btp-cockpit-setup.md` (76 CRLF lines, 3 H3 headings, parser=v2 → `parseV2Steps` returns 0 steps). |
| **Empty source files at upstream** | 1/11 | `abap-environment-create-tile.md` is **literally 0 bytes** in the source repo on GitHub (`api.github.com/.../contents/abap-environment-create-tile.md` returns `size: 0`). Author-side stub. The validator currently quarantines with `Missing required frontmatter field: type` — accurate but unhelpful for triage. |
| **Stepless overview docs** | 1/11 | `btp-transport-management-cpi-01-use-case.md` declares `parser: v2` but legitimately has zero `### ` step headings — it's a "scenario overview" doc with `## ` H2 sections only. Author-side mismatch between content shape and parser model. |

Only the first class is a code bug. The other two are author-side problems and the validator should keep flagging them.

## Goal

Recover the CRLF-affected tutorials so they parse correctly and pass validation. Make the empty-source failure mode self-explanatory in the quarantine log so authors can triage without help. Leave stepless overview docs to the authors (out of scope; future content-side decision).

## Approach

Two changes:

### 1. Centralize line-ending normalization in `composeTutorial()`

**[scripts/parsers/compose.ts](../../../scripts/parsers/compose.ts)**: at the very top of the function, normalize `rawMd` to LF line endings:

```ts
export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  const normalized = rawMd.replace(/\r\n?/g, '\n')  // CRLF or CR-only → LF
  const { title, description, ... } = extractFrontmatter(normalized)
  // ... rest unchanged
}
```

A single normalization at the entry point means every downstream parser (`extractFrontmatter`, `resolveImageURLs`, `convertOptionBlocks`, `extractBranchGroups`, `parseV1Steps`, `parseV2Steps`) sees consistent LF input. Defense against any future regex-with-`$` bug too — they all benefit.

The replace covers three cases the wild produces:
- `\r\n` (Windows / GitHub-from-Windows-clients) → `\n`
- `\r` alone (legacy Mac) → `\n`
- `\n` alone (Unix) → unchanged

**Why not in `extractFrontmatter`?** That helper only handles the YAML front-matter and a tiny slice of the body; the rest of the body still flows through `composeTutorial` unaltered. Doing it at the compose entry is more comprehensive.

**Why not in `parseV2Steps`/`parseV1Steps`?** A per-parser fix leaves `branches.ts`, `options.ts`, and any future regex-using helper exposed. Centralizing avoids that whack-a-mole.

### 2. Distinguish 0-byte sources from missing-field errors in the validator

**[scripts/validate-tutorials.ts](../../../scripts/validate-tutorials.ts)**: before the `REQUIRED_FIELDS` loop, check for empty content and emit a specific reason:

```ts
const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
let reason: string | null = null

if (content.trim().length === 0) {
  reason = `Tutorial source is empty (0 bytes) — likely an empty stub in the upstream repo`
} else {
  try {
    const { data: fm } = matter(content)
    // ... existing field validation ...
  }
}
```

This converts the cryptic `Missing required frontmatter field: type` (true but unhelpful — frontmatter is empty because the file is empty) into an actionable message that points authors at the upstream stub. No behavioral change otherwise: still quarantines, still proceeds with the rest of the run.

### What does NOT change

- **Validator field rules**: `stepCount > 0` stays as-is. We're fixing the parser so it produces `stepCount > 0` for the affected tutorials, not weakening the validator.
- **Parser regexes** (`parseV1Steps`, `parseV2Steps`, branch/options parsers): unchanged. The centralized normalization makes them all CRLF-immune without per-parser edits.
- **Stepless overview docs**: stay quarantined. The author either needs to add `### ` step delimiters or restructure the content.
- **Fetch-tutorials behavior** for empty upstream sources: still writes the empty cache file. A separate concern (fetch-side filtering) is deferred.
- **Carry-forward semantics on the publish side**: the validator's quarantine + the publish session's commit-time carry-forward of unchanged slugs continue to work as today. Once a CRLF-affected tutorial passes validation, its delta-publish payload contains real content again.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **Centralize normalization in `composeTutorial()`** (this design) | Single 1-line fix. Defends every downstream parser. Future-proof. Easy to test. | Adds one allocation per tutorial (negligible — ~5KB strings). | **Chosen** |
| Per-parser regex tightening (`/^### (.+?)\s*$/`) | Surgical to the failing parsers. | Doesn't help branch/options parsers if they have similar bugs. Leaves the next CRLF problem un-fixed. | Rejected |
| Centralize + tighten regexes (defense-in-depth) | Robust. | Mostly redundant once the central fix is in. The "tighten" half is YAGNI until something else breaks. | Rejected |
| Reject CRLF input at fetch-time | Stops the bug at the source. | Fragile — GitHub may serve CRLF for legitimate reasons; rejecting would lose tutorials we can otherwise handle. | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| Future tutorial uses `\r\n` line endings | Normalized at `composeTutorial()` entry; all parsers see LF. | None. |
| Future tutorial uses `\r` only (CR-only) | Same — `\r\n?` covers both. | None. |
| Tutorial body has stray `\r` mid-line (rare; e.g. inside a code block) | Replaced with `\n` — could affect rendered output of the code block. | Acceptable — `\r` mid-line is virtually never authored intentionally; if it ever is, escape it as `\r` text. |
| Tutorial source is 0 bytes (upstream stub) | Quarantine with `Tutorial source is empty (0 bytes) — likely an empty stub in the upstream repo`. | Author fixes the source repo. |
| Tutorial declares `parser: v2` but has no `### ` headings | Quarantine with `Invalid stepCount value: 0` (existing behavior). | Author adds `### ` headings or removes the `parser: v2` declaration. |

## Out of scope

- Fixing #2 author-side (empty stub upstream).
- Fixing #3 author-side (stepless overview docs — content/parser-config decision; deferred).
- Adding multi-issue triage to the quarantine summary (e.g. group quarantines by reason).
- Touching `publish-content.ts`'s carry-forward behavior.
- Modifying `fetch-tutorials.ts` to drop empty sources (fetch-side filtering — separate decision).

## Verification

1. **Unit tests** for a new exported `normalizeLineEndings(s: string): string` helper covering: pass-through LF, `\r\n` → `\n`, `\r` → `\n`, mixed input, empty string.
2. **Regression tests** on `parseV2Steps` (and `parseV1Steps` for symmetry) feeding CRLF input that contains valid H3 (V2) / ACCORDION (V1) markers — assert non-zero steps.
3. **Integration test** on `composeTutorial()` using a CRLF fixture (the actual `btp-cockpit-setup.md` shape: `parser: v2` + 3 `### ` headings) — assert `result.steps.length === 3`.
4. **Validator unit test** for the new 0-byte reason message.
5. **End-to-end (manual / CI)**: after the next `rebuild-content.yml` workflow run, the quarantine count drops by ~8 tutorials (the CRLF cohort). The remaining 1–2 quarantines are the genuine empty-stub and stepless cases.

## References

- Issue: [#432](https://github.com/sap-tutorials/tutorials-ims/issues/432)
- Related (same masking pattern): [#425](https://github.com/sap-tutorials/tutorials-ims/issues/425) — validator regex bug surfaced by carry-forward
- Memory: `feedback_carry_forward_masks_validator_bugs`
- Affected files: [scripts/parsers/compose.ts](../../../scripts/parsers/compose.ts), [scripts/validate-tutorials.ts](../../../scripts/validate-tutorials.ts)
- Investigated parsers: [scripts/parsers/v1.ts](../../../scripts/parsers/v1.ts), [scripts/parsers/v2.ts](../../../scripts/parsers/v2.ts)
- Sample reproductions (LOCAL `.tutorial-cache/`): `btp-cockpit-setup.md` (76 CRLF, 3 H3, parser=v2 → 0 steps before fix); `abap-environment-create-tile.md` (0 bytes); `btp-transport-management-cpi-01-use-case.md` (parser=v2, 0 H3).
