# Content Reuse and References

This guide explains how to use the four content-reuse features in tutorial markdown.

## ::include — Inline shared snippets

Snippets are reusable markdown fragments stored in a repo's `_snippets/` directory or in the shared `tutorial-snippets` repo. Use `::include` to inline them at build time.

**Syntax:**
```
::include[snippet-name]
::include[snippet-name]{param1=value1 param2=value2}
::include[shared:install-cf-cli]
```

**Rules:**
- Snippets live at `<repo>/_snippets/<name>.md` (or `shared/<name>` for the shared repo prefix `shared:`)
- Snippets must NOT contain step headings (`### Step N`) — this would corrupt step numbering
- Maximum include depth is 3 (A includes B includes C, but C cannot include further)
- Circular includes are rejected with `directive/include-cycle`

**Parameters:**
Declare `{{param:name}}` placeholders in the snippet. Pass values as `{name=value}` in the directive:
```
::include[btp-trial-setup]{region=eu10}
```

**To enable for your repo:** Contact the platform team to add your repo to `SNIPPETS_ENABLED_REPOS`.

---

## Smart reference links

Inline links to SAP resources use `:directive[label]` syntax (colon prefix, no `::`).

### :tutorial — Cross-reference another tutorial

```
:tutorial[hana-cloud-tutorial-1]
:tutorial[hana-cloud-tutorial-1]{label=Get Started with HANA}
```

Links to `/tutorials/<slug>`. In the rendered page, shows completion status if the user is authenticated.

### :note — SAP Note link

```
:note[2471802]
```

Renders as "SAP Note 2471802" linking to `https://me.sap.com/notes/2471802`. The label must be digits only.

### :help — SAP Help Portal link

```
:help[cap/docs/about-cap]
```

Links to `https://help.sap.com/docs/<path>`. Title is resolved at build time when available (falls back to the path).

### :api — API documentation link

```
:api[cds.ql.SELECT]{lib=cap-node}
```

Supported `lib` values: `cap-node`, `cap-java`, `ui5`, `cloud-sdk-js`, `cloud-sdk-java`.

### :since — Version badge

```
:since[CAP 10]
```

Renders a version tag badge. Use for "Added in version X" callouts.

---

## testedWith — Declare tested tool versions

Add a `testedWith` map to your frontmatter to declare the tool/library versions your tutorial was written and tested with:

```yaml
testedWith:
  "@sap/cds": "10.x"
  node: "22"
  "SAP BTP CLI": "2.x"
```

This renders a collapsible "Tested with" panel at the top of your tutorial. The freshness detector also uses this to flag tutorials whose declared versions are behind the current known major.

**Constraints:**
- Maximum 10 entries
- Keys and values must be non-empty strings
- Use version strings like `"10.x"`, `"22"`, `"2.6.1"` (any format with a leading digit)

---

## ::requires — Prerequisite cards

Show a prerequisite card linking to another tutorial:

```
::requires[hana-cloud-tutorial-1]
::requires[optional-tutorial-slug]{optional}
```

The card displays the tutorial title, estimated time, and (for authenticated users) completion status. Mark optional prerequisites with `{optional}`.

**Alternative:** List prerequisites in frontmatter using the `requires:` key:

```yaml
requires:
  - hana-cloud-tutorial-1
  - hana-cloud-tutorial-2
```

Note: the `requires:` frontmatter list is stored in the tutorial record. The `::requires` directive adds visual cards in the tutorial body.
