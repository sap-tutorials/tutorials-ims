# Format Mapping: Discovery Center → sap-tutorials Platform

This reference documents every structural transformation the `sap-discovery-tutorial-sync` skill applies when converting a SAP Discovery Center tutorial into the sap-tutorials v2-parser format.

---

## Source → Target Mapping Table

| Discovery Center source | Our platform target |
|---|---|
| No frontmatter | Required YAML frontmatter (`parser:v2`, `primary_tag`, `tags`, `time`, `author_name`, `author_profile`) |
| First `## Title` | `# Title` + `<!-- description -->` line |
| `### Section` | `### Step` (one H3 = one step) |
| `<details [open]><summary>LABEL</summary>…</details>` | `[OPTION BEGIN [LABEL]]…[OPTION END]` |
| `![x](./img.png)` + `<!-- border; size:540px -->` layout comment | `![x](img.png)` (strip `./`, strip layout comment), image in slug-named folder |
| `>` / `> [!NOTE]` callouts | Pass through unchanged |
| No quiz | Optional `rules.vr` in the `<repo>-Contribution` repo |

---

## OPTION Block Syntax

Discovery Center `<details>` collapsible sections become OPTION blocks in our format.

**Exact marker syntax:**

```
[OPTION BEGIN [LABEL]]
…content…
[OPTION END]
```

- `[OPTION BEGIN [LABEL]]` must be on its own line, followed by a newline before content.
- `[OPTION END]` must be on its own line with no trailing text.
- LABEL is the visible tab/option name (e.g. `Windows`, `macOS`, `Using BAS`).

**Parser regex (for reference):**

```js
/\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g
```

---

## OS-Classifier Recognition Table

When OPTION block labels match known OS names, the platform auto-wires a global OS picker instead of a plain tab strip.

**Canonical OS identifiers:**

| Canonical OS | Recognized labels (case-insensitive) |
|---|---|
| `Windows` | `win`, `win32`, `win64` |
| `macOS` | `mac`, `mac os`, `macos`, `os x`, `darwin` |
| `Linux` | `ubuntu`, `debian`, `fedora`, `unix` |
| `BAS` | `business application studio`, `sap bas` |

**Combined label matching:** Labels like `Mac and Linux` or `Mac & Linux` match multiple canonical OSes simultaneously.

**Auto-wire rule:** The OS global picker is activated **only** when a group has **≥ 2 distinct canonical OSes** across its OPTION blocks. If fewer than 2 distinct OSes are detected, the blocks render as a regular tab strip.

**Important:** The skill preserves source labels exactly — it does NOT invent or rename OS labels. If the source says `Using BAS`, the output says `Using BAS`.

---

## Quiz / Validation Syntax (`rules.vr`)

Quizzes are defined in a `rules.vr` file in the `<repo>-Contribution` repository. They are optional but recommended for knowledge checks.

### Block structure

Each validation block is numbered and wraps sub-markers:

```
[VALIDATE_1]
###Rule
multiple-choice
###Question
What is 2+2?
###Match
[X] 4
[ ] 5
[VALIDATE_END_1]
```

**Marker conventions:**
- Opening marker: `[VALIDATE_N]` where N is a 1-based integer.
- Closing marker: `[VALIDATE_END_N]` (must match the opening N).
- `###Rule` — on its own line; the rule **type** follows on the **next** line.
- `###Question` — on its own line; question text follows on the next line.
- `###Match` — on its own line; answer options follow, one per line.
- `[X]` marks a correct answer; `[ ]` marks an incorrect answer.

**Rule types:**
- `single-choice` — renders as radio buttons (exactly one correct answer).
- `multiple-choice` — renders as checkboxes (one or more correct answers).

**AI grading:** Add a `###Grading` sub-marker with value `ai-judged` to opt a question into AI-based grading (suitable for free-text answers).

### `[AUTOAUTHOR_ALL]` directive

Place `[AUTOAUTHOR_ALL]` as a top-level line in `rules.vr` to instruct the platform to **generate quiz questions automatically** from step text at build time.

Optional suffix controls the generated question type:
- `[AUTOAUTHOR_ALL]` — generates both MCQ and text-answer questions.
- `[AUTOAUTHOR_ALL:mcq]` — generates multiple-choice questions only.
- `[AUTOAUTHOR_ALL:text]` — generates text-answer questions only.

This directive does not replace hand-authored `[VALIDATE_N]` blocks; both can coexist.

---

## Image Path Normalization

- Strip the leading `./` from relative image paths: `./img.png` → `img.png`.
- Strip inline layout comments such as `<!-- border; size:540px -->` that follow an image tag.
- Place all tutorial images in a folder named after the tutorial slug (e.g. `tutorials/my-tutorial/img.png`).

---

## Edge Cases — Flagged, Not Auto-Handled

The following constructs are detected and flagged in the conversion report. The skill does **not** attempt to auto-convert them; the author must resolve them manually.

| Edge case | Why it is flagged |
|---|---|
| Nested `<details>` | Our OPTION syntax has no nesting support; content would be silently dropped or mis-parsed. |
| Unbalanced / malformed `<details>` | Missing `</details>` or `</summary>` causes incorrect block boundaries. |
| H4 / H5 headings inside a step | The v2 parser treats H3 as step boundaries; H4/H5 inside a step have no semantic mapping and may break the step outline. |
| Code fence with no language tag | Fenced blocks without a language identifier (` ``` ` with no lang) trip the fence-lint check and should be tagged (e.g. ` ```bash`, ` ```json`). |
