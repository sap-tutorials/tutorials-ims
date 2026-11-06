---
title: Tutorial Callout Enhancements Demo
author_name: Platform Team
author_profile: https://github.com/sap-tutorials
primary_tag: topic>abap-development
tags: [topic>abap-development]
time: 5
---

### Step 1: Standard alert callouts

The five standard alert types (NOTE, TIP, IMPORTANT, WARNING, CAUTION) are non-collapsible
and render with an icon. Use them for emphasis, not decoration.

> [!NOTE]
> This is a note. Use it for supplementary information that doesn't interrupt the flow.

> [!TIP]
> This is a tip. Use it for helpful shortcuts or best practices.

> [!WARNING]
> This is a warning. Use it when the reader could lose work or cause unexpected behavior.

> [!CAUTION]
> This is a caution. Use it for severe or irreversible consequences.

> [!IMPORTANT]
> This is important. Use it for key information the reader must not miss.

Any alert type accepts an optional title after the designator:

> [!NOTE] Custom heading
> This note has a custom heading above its body text.

### Step 2: DETAILS callouts

DETAILS is a collapsible section. A title is **required**. By default the section starts
closed; append `+` to start it open.

> [!DETAILS] Closed by default — click to expand
> This content is hidden until the reader clicks the heading.
>
> It can contain multiple paragraphs, lists, and code blocks.
>
> ```yaml
> key: value
> ```

> [!DETAILS+] Open by default — click to collapse
> This content is visible immediately. Use `+` when the reader is likely to need the
> content on a first pass but it would clutter the step if always-visible.

### Step 3: TROUBLESHOOT callouts

TROUBLESHOOT callouts are collapsible and contribute to the auto-generated troubleshooting
index at the bottom of the tutorial. A title is optional but recommended.

> [!TROUBLESHOOT] `cds watch` exits immediately with "No service definition found"
> Ensure at least one `.cds` file in `srv/` contains a `service` definition. Check that
> `package.json` lists the correct `cds.roots` paths.
>
> ```bash
> ls srv/*.cds
> ```
>
> If the folder is empty, you may have cloned the wrong branch.

> [!TROUBLESHOOT] Port 4004 is already in use
> Another `cds watch` process is running. Kill it first:
>
> ```bash
> npx kill-port 4004
> ```

### Step 4: RESULT callouts

RESULT marks the expected outcome after completing an action. It has a default title of
"You should see" and a checkmark icon. Place it immediately after the action step.

Run the build:

```bash
npm run build
```

> [!RESULT]
> The terminal prints `Build succeeded` and exits with code 0. The `dist/` folder now
> contains `index.html`.

You can also provide a custom title:

> [!RESULT] Terminal output
> ```
> ✓ 3 tests passed
> ```

> **Note:** Automatic verification links (assert-link) for RESULT callouts are deferred
> to a follow-up feature.

### Step 5: HINT and SOLUTION callouts

Multiple HINT callouts in the same step unlock one at a time — the reader must open the
first before the second becomes visible. Place SOLUTION at the end of the exercise.

**Exercise:** What CAP annotation marks a service endpoint as read-only?

> [!HINT]
> Look at the service definition in `srv/cat-service.cds`.

> [!HINT]
> The annotation starts with `@readonly`.

> [!HINT]
> It is placed before the entity projection inside the `service` block.

> [!SOLUTION]
> Add `@readonly` before the entity projection:
>
> ```cds
> service CatalogService {
>   @readonly entity Books as SELECT from my.Books;
> }
> ```

### Step 6: Inline spoilers and directive syntax

Use `:spoiler[text]` to blur an answer inline — useful for quiz-style prompts:

Which SAP framework is used to build cloud-native business applications? :spoiler[CAP (Cloud Application Programming Model)]

In plain-text contexts (MCP tool, email) the spoiler renders as `||CAP (Cloud Application Programming Model)||`.

The `:::details[Title]` directive syntax is equivalent to `> [!DETAILS] Title` and is
useful when the body contains content that is awkward inside a `>` blockquote:

:::details[Full configuration file]
```yaml
cds:
  requires:
    db:
      kind: hana
  features:
    ieee754compatible: true
```
:::

### Step 7: Directive equivalents for HINT and SOLUTION

All collapsible callout types have a `:::type[Title]` directive equivalent. This form is
interchangeable with the blockquote form.

:::hint[Need a hint?]
Check the CAP documentation for `cds.ql` query examples.
:::

:::solution[Full solution]
```js
const books = await SELECT.from('my.Books').where({ author_ID: authorId })
```
:::

:::troubleshoot[Module not found: @sap/cds]
Run `npm install` to restore node_modules, then verify `@sap/cds` is listed in
`dependencies` (not `devDependencies`) in `package.json`.
:::

:::result
The application starts without errors and the terminal shows `Server is listening on port 4004`.
:::

[DONE]
