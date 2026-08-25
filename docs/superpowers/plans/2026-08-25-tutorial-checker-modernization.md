# Tutorial CI — SAP Content Checker Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy AEM-era `tutorial-checker` rules with a slim, modern SAP content checker that validates tutorial markdown against the *current* build pipeline contract (`scripts/parsers/`), packaged as a composite action and wired into the notify-only PR checks pipeline as the `content` finding category.

**Architecture:** A self-contained Node module in `sap-tutorials/tutorial-ci` under `checker/` exposes `runChecks(markdown, filename) → Finding[]` built from small single-responsibility rule functions, each unit-tested against fixtures. A CLI entry reads changed `.md` files and prints findings JSON; a composite `checker/action.yml` wraps it; the reusable workflow (Plan 1, Task 4) gains a step that merges these into `findings.json` under `category: "content"`. This lands after Plan 1's pilot proves the pipeline.

**Tech Stack:** Node.js (ESM), Vitest, `gray-matter` (frontmatter parse, same lib the pipeline uses), `yaml` (1.1 coercion detection), GitHub composite action.

**Spec:** `docs/superpowers/specs/2026-08-25-org-tutorial-pr-checks-design.md` (§7)

**Depends on:** Plan 1 (`2026-08-25-tutorial-ci-pr-checks-pipeline.md`) — the `tutorial-ci` repo, the `Finding` schema, `scripts/normalize-findings.js`, and the reusable workflow must exist first.

**Contract source of truth:** `scripts/parsers/{frontmatter,rules,options,types,os-classifier}.ts` in the `tutorials-ims` repo. Rule authors read these — the checker mirrors what the parsers require/tolerate, not legacy AEM behavior.

## Global Constraints

- **Notify, never block.** Every content finding is `severity: warning` or `notice`; the checker CLI always exits 0; the composite action never fails the job.
- **Findings schema** (shared with Plan 1): `{category: "content", file, line, severity, rule, message}`. `rule` is a stable kebab-case id (e.g. `frontmatter-missing-field`).
- **Mirror the parser, don't exceed it.** A rule fires only where the current pipeline would misbehave or drop content. When unsure whether a legacy rule still matters, the triage (Task 1) decides — default to **drop** rather than invent new strictness.
- **Line numbers required.** Every finding carries the 1-based source line where possible (fall back to line 1 for whole-file/frontmatter issues, noting the field).
- **No network.** Link/spell checking stays in Plan 1's off-the-shelf tools (lychee/markdownlint). This checker is structure/contract only.

### Current contract (verbatim from the parsers — the checker validates against this)

- **Required frontmatter:** `time` (number), `author_name` (string), `author_profile` (string), `tags` (string[]), `primary_tag` (string). Optional: `parser`, `title`, `description`, `video`, `osOverrides`. `githubLogin` is computed at fetch — never author-supplied.
- **`time` coercion:** the pipeline coerces `"30 mins"` → `30` but **drops** unparseable values (card shows no time). Warn when `time` is a string or lacks digits.
- **Sanitizer-detectable defects** (the pipeline silently repairs these; the checker should *surface* them so authors fix the source): git merge-conflict markers (`<<<<<<<`/`=======`/`>>>>>>>`), missing space after a YAML key colon (`tags:[`), double commas in arrays (`,,`).
- **YAML 1.1 booleans:** bare `yes/no/on/off/true/false` values in frontmatter coerce to booleans (Hugo reads YAML 1.1). Warn on unquoted `yes/no/on/off` in string-typed fields.
- **Body sections:** `# <title>` H1 (or `title:` frontmatter); `<!-- description -->` + text (or `description:`); `## You will learn` as a `-` bullet list; `## Prerequisites` section; at least one step `## ` heading.
- **Level:** derived from a `tags` entry containing `tutorial>beginner|intermediate|advanced`; absence defaults to beginner (warn — author likely forgot the level tag).
- **Validation blocks:** `[VALIDATE_N]` … containing `###Rule`, `###Question`, `###Match`, optional `###Grading`. A block needs `###Question` AND (`###Match` for text, or MCQ options) to emit — otherwise it is silently dropped. MCQ options: `[x]`/`[X]` = correct, `[ ]`/`[]` = distractor; `single-choice` needs exactly one `[x]`, `multiple-choice` needs ≥1. Rule types: `single-choice`, `multiple-choice`, `regex`, `regex-begins-with`, or text. **Footgun:** MCQ + `###Grading: ai-judged` parses but the runtime rejects it (`wrong_question_type`) — warn.
- **AUTOAUTHOR directives:** `[AUTOAUTHOR_N]`, `[AUTOAUTHOR_N:mcq|text]`, `[AUTOAUTHOR_ALL]`, `[AUTOAUTHOR_ALL:mcq|text]` — recognized; a malformed suffix is ignored silently (warn on unknown suffix).
- **Options blocks:** `[OPTION BEGIN [TabName]]` … `[OPTION END]` — must be balanced and each BEGIN carries a `[TabName]`.
- **Slug/paths:** tutorial markdown lives at `tutorials/<slug>/<slug>.md`; slugs are lowercase-canonical. Markdown in the repo root or a mixed-case slug will 404 / mis-route.

---

### Task 1: Legacy rule inventory + triage decision table

**Files:**
- Create: `checker/TRIAGE.md`

**Interfaces:**
- Produces: the keep/update/drop decision that Tasks 3–7 implement. Each "keep"/"update" row names the target rule id used later.

- [ ] **Step 1: Inventory the legacy checkers**

Read the legacy `sap-tutorials/tutorial-checker` `test-tool/src/checkers/` (spell, content, link, options, file-name, validations, tags, metadata, syntax) and `analyze/` (VALIDATE/DONE accordion). For each, note in `checker/TRIAGE.md` what it asserted.

- [ ] **Step 2: Triage each against the current contract**

For every legacy rule, decide **keep / update / drop** against the "Current contract" section above and the parser source. Record as a table: `legacy check | still relevant? | decision | new rule id | notes`. Guidance: link/spell → **drop** (covered by lychee/markdownlint in Plan 1); metadata/tags → **update** to the current required-field set; validations/syntax → **update** to the `[VALIDATE_N]`/`###` contract; VALIDATE/DONE accordion → **drop** unless the parser still honors it (it does not). Add **new** rows for contract items with no legacy equivalent: `time`-coercion warn, merge-marker surface, YAML-1.1 boolean warn, MCQ+ai-judged footgun, slug/path.

- [ ] **Step 3: Commit**

```bash
git add checker/TRIAGE.md
git commit -m "docs: legacy tutorial-checker rule triage against current parser contract"
git push
```

---

### Task 2: Checker harness + Finding type

**Files:**
- Create: `checker/index.js`, `checker/rules/index.js`
- Create: `checker/test/harness.test.js`

**Interfaces:**
- Produces: `runChecks(markdown: string, filename: string) → Finding[]` where `Finding = {category:"content", file, line, severity, rule, message}`. Rules register as `(ctx) => Finding[]` where `ctx = {markdown, filename, lines, frontmatter, body, frontmatterEndLine}`.
- Produces: `parseContext(markdown, filename) → ctx` using `gray-matter` (frontmatter + body split) and precomputed `lines` + `frontmatterEndLine` (line index where `---` closes, for frontmatter finding line numbers).

- [ ] **Step 1: Write failing harness test**

```js
import { test, expect } from "vitest";
import { runChecks } from "../index.js";

test("runChecks returns [] for empty rule set on clean input", () => {
  const md = "---\ntitle: X\n---\n# X\n";
  expect(runChecks(md, "tutorials/x/x.md")).toEqual([]);
});

test("a registered rule receives parsed context and its findings carry file+category", () => {
  const md = "---\ntitle: X\n---\n# X\n";
  const findings = runChecks(md, "tutorials/x/x.md", [
    (ctx) => [{ line: 1, severity: "warning", rule: "probe", message: ctx.filename }],
  ]);
  expect(findings[0]).toEqual({ category: "content", file: "tutorials/x/x.md", line: 1, severity: "warning", rule: "probe", message: "tutorials/x/x.md" });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/harness.test.js`
Expected: FAIL — `../index.js` not found.

- [ ] **Step 3: Implement `checker/index.js`**

Implement `parseContext` (gray-matter parse; compute `lines = markdown.split("\n")`; `frontmatterEndLine` = index of the second `---`) and `runChecks(markdown, filename, rules = allRules)` that runs each rule with the context, stamps `category:"content"` + `file:filename` onto every returned partial finding, and returns the flat array. `checker/rules/index.js` exports `allRules` (empty array for now; Tasks 3–7 append).

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/harness.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add checker/index.js checker/rules/index.js checker/test/harness.test.js
git commit -m "feat: content-checker harness (parseContext + runChecks)"
git push
```

---

### Task 3: Frontmatter rules

**Files:**
- Create: `checker/rules/frontmatter.js`
- Modify: `checker/rules/index.js` (register the rules)
- Create: `checker/test/frontmatter.test.js`

**Interfaces:**
- Consumes: `ctx` from Task 2.
- Produces: rule ids `frontmatter-missing-field`, `frontmatter-time-not-numeric`, `frontmatter-merge-marker`, `frontmatter-yaml11-boolean`, `frontmatter-empty-tags`, `frontmatter-missing-level-tag`.

- [ ] **Step 1: Write failing tests**

```js
import { test, expect } from "vitest";
import { runChecks } from "../index.js";
import { frontmatterRules } from "../rules/frontmatter.js";
const check = (md) => runChecks(md, "tutorials/x/x.md", frontmatterRules);

test("missing required fields are each reported", () => {
  const md = "---\ntitle: X\n---\n# X\n";
  const rules = check(md).map((f) => f.rule);
  expect(rules).toContain("frontmatter-missing-field"); // time/author_name/author_profile/tags/primary_tag absent
  const msgs = check(md).map((f) => f.message).join(" ");
  expect(msgs).toMatch(/author_name/);
  expect(msgs).toMatch(/primary_tag/);
});

test("string time that has no digits is flagged", () => {
  const md = "---\ntime: soon\nauthor_name: A\nauthor_profile: https://github.com/a\ntags: [x]\nprimary_tag: t\n---\n# X\n";
  expect(check(md).map((f) => f.rule)).toContain("frontmatter-time-not-numeric");
});

test("numeric-coercible string time does NOT flag", () => {
  const md = "---\ntime: 30 mins\nauthor_name: A\nauthor_profile: https://github.com/a\ntags: [x]\nprimary_tag: t\n---\n# X\n";
  expect(check(md).map((f) => f.rule)).not.toContain("frontmatter-time-not-numeric");
});

test("merge conflict markers are surfaced", () => {
  const md = "---\ntitle: X\n---\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n";
  expect(check(md).map((f) => f.rule)).toContain("frontmatter-merge-marker");
});

test("unquoted yes/no value coerces to boolean under YAML 1.1", () => {
  const md = "---\nprimary_tag: no\ntime: 5\nauthor_name: A\nauthor_profile: https://github.com/a\ntags: [x]\n---\n# X\n";
  expect(check(md).map((f) => f.rule)).toContain("frontmatter-yaml11-boolean");
});

test("missing tutorial>level tag warns", () => {
  const md = "---\ntime: 5\nauthor_name: A\nauthor_profile: https://github.com/a\ntags: [software-product>x]\nprimary_tag: t\n---\n# X\n";
  expect(check(md).map((f) => f.rule)).toContain("frontmatter-missing-level-tag");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/frontmatter.test.js`
Expected: FAIL — `../rules/frontmatter.js` not found.

- [ ] **Step 3: Implement `checker/rules/frontmatter.js`**

Export `frontmatterRules` (array of rule fns):
- **Required fields:** for each of `time, author_name, author_profile, tags, primary_tag` absent/empty in `ctx.frontmatter`, emit `frontmatter-missing-field` (`warning`, line 1, message names the field).
- **time numeric:** if `time` present and (string without a digit / not finite), emit `frontmatter-time-not-numeric` (`warning`). Mirror `coerceTime`: a string with `\d+` is OK.
- **merge markers:** scan `ctx.lines` for `^<<<<<<< |^=======$|^>>>>>>> `; emit `frontmatter-merge-marker` (`warning`) at the matching line.
- **YAML 1.1 boolean:** re-parse the raw frontmatter block with the `yaml` lib in 1.1 mode (or regex the raw block for `^\s*\w+:\s*(yes|no|on|off)\s*$` case-insensitive, excluding quoted); emit `frontmatter-yaml11-boolean` (`warning`) at that line. (This is the `hugo-frontmatter-yaml-11` gotcha.)
- **empty tags / missing level:** if `tags` is empty → `frontmatter-empty-tags`; if no tag contains `tutorial>beginner|intermediate|advanced` → `frontmatter-missing-level-tag` (both `notice`).

Append `...frontmatterRules` to `allRules` in `checker/rules/index.js`.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/frontmatter.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add checker/rules/frontmatter.js checker/rules/index.js checker/test/frontmatter.test.js
git commit -m "feat: frontmatter content-check rules (required fields, time, merge markers, yaml1.1, level tag)"
git push
```

---

### Task 4: Body-structure rules

**Files:**
- Create: `checker/rules/body.js`
- Modify: `checker/rules/index.js`
- Create: `checker/test/body.test.js`

**Interfaces:**
- Produces: rule ids `body-missing-title`, `body-missing-you-will-learn`, `body-missing-prerequisites`, `body-no-steps`.

- [ ] **Step 1: Write failing tests**

```js
import { test, expect } from "vitest";
import { runChecks } from "../index.js";
import { bodyRules } from "../rules/body.js";
const check = (md) => runChecks(md, "tutorials/x/x.md", bodyRules).map((f) => f.rule);

const FM = "---\ntime: 5\nauthor_name: A\nauthor_profile: https://github.com/a\ntags: [tutorial>beginner]\nprimary_tag: t\n---\n";

test("no H1 and no title frontmatter → missing title", () => {
  expect(check(FM + "some text\n")).toContain("body-missing-title");
});

test("H1 present → no missing-title", () => {
  expect(check(FM + "# Hello\n## You will learn\n- a\n## Prerequisites\nnone\n## Step 1\nx\n")).not.toContain("body-missing-title");
});

test("missing You will learn and Prerequisites are reported", () => {
  const r = check(FM + "# Hello\n## Step 1\nx\n");
  expect(r).toContain("body-missing-you-will-learn");
  expect(r).toContain("body-missing-prerequisites");
});

test("no step headings → body-no-steps", () => {
  expect(check(FM + "# Hello\n## You will learn\n- a\n## Prerequisites\nnone\n")).toContain("body-no-steps");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/body.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `checker/rules/body.js`**

Export `bodyRules`:
- `body-missing-title` (`warning`): no `^# ` in body AND no `title` in frontmatter.
- `body-missing-you-will-learn` (`notice`): no `^## You will learn` heading.
- `body-missing-prerequisites` (`notice`): no `^## Prerequisites` heading.
- `body-no-steps` (`warning`): fewer than one `^## ` heading that is not `You will learn`/`Prerequisites`.

Use `ctx.body` line scanning; report the relevant line (heading line, or line 1 for absence). Register in `allRules`.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/body.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add checker/rules/body.js checker/rules/index.js checker/test/body.test.js
git commit -m "feat: body-structure content-check rules"
git push
```

---

### Task 5: Validation-block rules

**Files:**
- Create: `checker/rules/validation.js`
- Modify: `checker/rules/index.js`
- Create: `checker/test/validation.test.js`

**Interfaces:**
- Produces: rule ids `validate-missing-question`, `validate-missing-answer`, `validate-mcq-no-correct`, `validate-mcq-ai-judged-footgun`, `validate-unknown-rule-type`, `autoauthor-unknown-suffix`.

- [ ] **Step 1: Write failing tests**

```js
import { test, expect } from "vitest";
import { runChecks } from "../index.js";
import { validationRules } from "../rules/validation.js";
const check = (md) => runChecks(md, "tutorials/x/x.md", validationRules).map((f) => f.rule);

test("VALIDATE block without ###Question is flagged (would be silently dropped)", () => {
  expect(check("[VALIDATE_1]\n###Rule\nregex\n###Match\nfoo\n")).toContain("validate-missing-question");
});

test("text VALIDATE block without ###Match is flagged", () => {
  expect(check("[VALIDATE_1]\n###Question\nWhat?\n")).toContain("validate-missing-answer");
});

test("single-choice with zero [x] options is flagged", () => {
  expect(check("[VALIDATE_1]\n###Rule\nsingle-choice\n###Question\nQ\n###Match\n[ ] a\n[ ] b\n")).toContain("validate-mcq-no-correct");
});

test("MCQ marked ai-judged is a footgun warning", () => {
  const md = "[VALIDATE_1]\n###Rule\nmultiple-choice\n###Question\nQ\n###Grading\nai-judged\n###Match\n[x] a\n[ ] b\n";
  expect(check(md)).toContain("validate-mcq-ai-judged-footgun");
});

test("unrecognized rule type warns", () => {
  expect(check("[VALIDATE_1]\n###Rule\nfuzzy-match\n###Question\nQ\n###Match\nfoo\n")).toContain("validate-unknown-rule-type");
});

test("AUTOAUTHOR with a bad suffix warns", () => {
  expect(check("[AUTOAUTHOR_2:essay]\n")).toContain("autoauthor-unknown-suffix");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/validation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `checker/rules/validation.js`**

Export `validationRules`. Walk `ctx.lines` grouping `[VALIDATE_N]` blocks (mirror `parseRulesVrEnriched`'s block boundaries). For each block:
- no `###Question` → `validate-missing-question` (`warning`).
- text-type (rule not `single-choice`/`multiple-choice`) with no `###Match` content → `validate-missing-answer` (`warning`).
- MCQ-type with zero `[x]`/`[X]` markers in `###Match` → `validate-mcq-no-correct` (`warning`).
- MCQ-type with `###Grading: ai-judged` → `validate-mcq-ai-judged-footgun` (`warning`, message: "runtime rejects with wrong_question_type").
- `###Rule` value not in `{single-choice, multiple-choice, regex, regex-begins-with}` and non-empty and block has options/match → `validate-unknown-rule-type` (`notice`).
Separately, any `[AUTOAUTHOR_N:...]`/`[AUTOAUTHOR_ALL:...]` with a suffix other than `mcq`/`text` → `autoauthor-unknown-suffix` (`notice`). Report each at the block's line. Register in `allRules`.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/validation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add checker/rules/validation.js checker/rules/index.js checker/test/validation.test.js
git commit -m "feat: validation-block content-check rules"
git push
```

---

### Task 6: Options-block + slug/path rules

**Files:**
- Create: `checker/rules/options.js`, `checker/rules/paths.js`
- Modify: `checker/rules/index.js`
- Create: `checker/test/options.test.js`, `checker/test/paths.test.js`

**Interfaces:**
- Produces: rule ids `option-unbalanced`, `option-missing-tabname`, `path-uppercase-slug`, `path-wrong-location`.

- [ ] **Step 1: Write failing tests**

```js
import { test, expect } from "vitest";
import { runChecks } from "../index.js";
import { optionRules } from "../rules/options.js";
import { pathRules } from "../rules/paths.js";
const opt = (md) => runChecks(md, "tutorials/x/x.md", optionRules).map((f) => f.rule);
const pth = (name) => runChecks("---\ntitle: X\n---\n# X\n", name, pathRules).map((f) => f.rule);

test("OPTION BEGIN without a matching END is unbalanced", () => {
  expect(opt("[OPTION BEGIN [Java]]\nsome content\n")).toContain("option-unbalanced");
});

test("balanced OPTION block does not flag", () => {
  expect(opt("[OPTION BEGIN [Java]]\nx\n[OPTION END]\n")).not.toContain("option-unbalanced");
});

test("OPTION BEGIN missing the [TabName] is flagged", () => {
  expect(opt("[OPTION BEGIN []]\nx\n[OPTION END]\n")).toContain("option-missing-tabname");
});

test("uppercase in the slug path is flagged", () => {
  expect(pth("tutorials/MyTutorial/MyTutorial.md")).toContain("path-uppercase-slug");
});

test("markdown outside tutorials/<slug>/ is flagged", () => {
  expect(pth("readme-extra.md")).toContain("path-wrong-location");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/options.test.js checker/test/paths.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the two rule modules**

`optionRules`: count `[OPTION BEGIN [..]]` vs `[OPTION END]`; unequal → `option-unbalanced` (`warning`) at first unmatched line. `[OPTION BEGIN []]` or `[OPTION BEGIN ]` (no tab name) → `option-missing-tabname` (`warning`).
`pathRules`: operate on `ctx.filename`. If it matches `tutorials/.../` but any path segment has an uppercase letter → `path-uppercase-slug` (`warning`). If it ends `.md`, is not under `tutorials/<slug>/`, and is not a known meta file (`README.md`, `CONTRIBUTING.md`, etc.) → `path-wrong-location` (`notice`, message references the "new tutorial 404s = wrong repo folder" gotcha). Register both in `allRules`.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/options.test.js checker/test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add checker/rules/options.js checker/rules/paths.js checker/rules/index.js checker/test/options.test.js checker/test/paths.test.js
git commit -m "feat: options-block + slug/path content-check rules"
git push
```

---

### Task 7: Real-tutorial regression fixtures

**Files:**
- Create: `checker/test/fixtures/` (2–3 real tutorial `.md` files copied from a content repo, one known-good + one with a real historical defect)
- Create: `checker/test/regression.test.js`

**Interfaces:**
- Consumes: `runChecks` + `allRules`.
- Produces: confidence the full rule set has an acceptable false-positive rate on real content.

- [ ] **Step 1: Copy fixtures**

Copy a currently-published, known-good tutorial markdown into `fixtures/good-<slug>.md` (fetch via `gh api repos/sap-tutorials/<repo>/contents/tutorials/<slug>/<slug>.md`). Copy one with a known historical issue (e.g. string `time`, or missing level tag) into `fixtures/bad-<slug>.md`.

- [ ] **Step 2: Write the regression test**

```js
import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import { runChecks } from "../index.js";

test("a known-good published tutorial produces zero warnings", () => {
  const md = readFileSync(new URL("./fixtures/good-sample.md", import.meta.url), "utf8");
  const warnings = runChecks(md, "tutorials/good-sample/good-sample.md").filter((f) => f.severity === "warning");
  expect(warnings).toEqual([]); // if this fails, a rule is too strict — fix the rule, not the fixture
});

test("the known-bad fixture produces at least one finding", () => {
  const md = readFileSync(new URL("./fixtures/bad-sample.md", import.meta.url), "utf8");
  expect(runChecks(md, "tutorials/bad-sample/bad-sample.md").length).toBeGreaterThan(0);
});
```

(Rename fixtures to `good-sample.md`/`bad-sample.md` or adjust the URLs to the copied names.)

- [ ] **Step 3: Run, tune rules on false positives**

Run: `npx vitest run checker/test/regression.test.js`
Expected: PASS. If the good fixture yields warnings, the rule is too strict — relax the rule (per Global Constraints "mirror the parser, don't exceed it"), not the fixture. Re-run.

- [ ] **Step 4: Commit**

```bash
git add checker/test/fixtures checker/test/regression.test.js
git commit -m "test: real-tutorial regression fixtures for the content checker"
git push
```

---

### Task 8: CLI + composite action + pipeline wiring

**Files:**
- Create: `checker/cli.js`, `checker/action.yml`
- Modify: `.github/workflows/tutorial-pr-checks.yml` (Plan 1, Task 4) — add the checker step
- Modify: `scripts/normalize-findings.js` (Plan 1, Task 3) — accept pre-normalized `content` findings
- Create: `checker/test/cli.test.js`

**Interfaces:**
- Consumes: `runChecks` (Task 2), the reusable workflow + normalizer (Plan 1).
- Produces: `content` findings merged into `findings.json`; a composite action `sap-tutorials/tutorial-ci/checker@v1`.

- [ ] **Step 1: Write failing CLI test**

```js
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

test("cli prints content findings JSON for the given files and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "chk-"));
  const f = join(dir, "x.md");
  writeFileSync(f, "---\ntitle: X\n---\nno steps here\n");
  const out = execFileSync("node", ["checker/cli.js", f], { encoding: "utf8" });
  const findings = JSON.parse(out);
  expect(Array.isArray(findings)).toBe(true);
  expect(findings.every((x) => x.category === "content")).toBe(true);
  expect(findings.some((x) => x.rule === "frontmatter-missing-field")).toBe(true);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run checker/test/cli.test.js`
Expected: FAIL — `checker/cli.js` not found.

- [ ] **Step 3: Implement `checker/cli.js`**

Reads file paths from `argv.slice(2)` (space/newline separated), runs `runChecks` on each with its repo-relative path as `filename`, prints `JSON.stringify(allFindings)` to stdout, `process.exit(0)` always. Missing/unreadable files are skipped with a `console.error` (not stdout).

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run checker/test/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Write `checker/action.yml`**

Composite action: inputs `files` (newline-separated changed `.md` paths) + `output` (path to write JSON). Steps: `actions/setup-node`, `node ${{ github.action_path }}/cli.js` over the files, write to `output`. No `fail` behavior.

- [ ] **Step 6: Wire into the reusable workflow**

In `.github/workflows/tutorial-pr-checks.yml`, add a step after the linters: `uses: sap-tutorials/tutorial-ci/checker@v1` with the changed-markdown list, writing `content.json`. Update the normalize step to `node scripts/normalize-findings.js ml.json gl.json ly.json content.json`.

- [ ] **Step 7: Update the normalizer to pass content findings through**

In `scripts/normalize-findings.js`, extend the CLI shim: a 4th arg is a JSON file of already-normalized `content` findings; concatenate them into the output. Add a unit test in `test/normalize-findings.test.js`:

```js
test("pre-normalized content findings pass through unchanged", () => {
  const content = [{ category: "content", file: "x.md", line: 1, severity: "warning", rule: "body-no-steps", message: "no steps" }];
  const out = normalizeFindings({ markdownlint: [], gitleaks: [], lychee: [], content });
  expect(out).toContainEqual(content[0]);
});
```

- [ ] **Step 8: Run all checker + normalizer tests, expect PASS**

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 9: Commit + re-cut `v1`**

```bash
git add checker/cli.js checker/action.yml .github/workflows/tutorial-pr-checks.yml scripts/normalize-findings.js test/normalize-findings.test.js checker/test/cli.test.js
git commit -m "feat: content-checker CLI + composite action, wired into PR checks pipeline"
git push && git tag -f v1 && git push -f origin v1
```

---

### Task 9: Pilot verification of content checks

**Files:** none in-repo — live verification on the pilot repo (`btp-foundation-Contribution`).

- [ ] **Step 1: Fixture PR — content defects**

On the pilot repo, open a branch PR editing a tutorial to introduce a string-only `time`, drop the `## Prerequisites` section, and add a `[VALIDATE_1]` block missing `###Question`. Expected: sticky comment shows a `### Content (n)` section listing `frontmatter-time-not-numeric`, `body-missing-prerequisites`, `validate-missing-question`; inline annotations on the right lines; PR still mergeable; workflow exits 0.

- [ ] **Step 2: Fixture PR — clean tutorial**

Open a PR with a well-formed tutorial edit. Expected: no `Content` section (or "no issues"); no false positives.

- [ ] **Step 3: Record + tune**

If false positives appear on real content, relax the offending rule and re-cut `v1`; re-run. Note the outcome for Tom.

---

## Self-Review

**Spec coverage (§7):**
- §7.1 inventory → Task 1. §7.2 triage keep/update/drop → Task 1 Step 2. §7.3 add missing rules (required frontmatter, YAML 1.1 booleans, slug/casing, step-structure) → Tasks 3, 4, 6. §7.4 deliver behind `checker/action.yml`, unit-tested against fixtures → Tasks 2–8, regression Task 7. "Land incrementally after the generic pipeline" → this whole plan depends on Plan 1 and wires in at Task 8. "content category empty until modernization" (Plan 1 §Self-Review gap) → closed by Task 8 Step 7.

**Placeholder scan:** Each rule task carries concrete rule ids, concrete failing tests, and concrete implementation bullets tied to named parser behaviors. No "handle edge cases"/"TBD".

**Type consistency:** `Finding` shape `{category:"content", file, line, severity, rule, message}` consistent across all tasks and matches Plan 1's schema. `runChecks(markdown, filename, rules?)` and rule-fn signature `(ctx) → Finding[]` consistent Tasks 2–8. Rule-module exports (`frontmatterRules`, `bodyRules`, `validationRules`, `optionRules`, `pathRules`) each registered in `checker/rules/index.js`'s `allRules`. `v1` tag re-cut in Task 8 matches Plan 1's caller pin.
