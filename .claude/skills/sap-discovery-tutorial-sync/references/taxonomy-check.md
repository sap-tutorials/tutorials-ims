# Taxonomy Check: Tag Validation Reference

This reference documents how the `sap-discovery-tutorial-sync` skill validates `primary_tag` and `tags` values against the live platform taxonomy before writing a converted tutorial's frontmatter.

---

## Primary Tag Source

**Endpoint:**

```
GET ${CAP_BASE_URL}/build/tags
```

Default base URL: `http://localhost:4004`

**Response shape:**

```json
{ "tags": ["tutorial>beginner", "tutorial>intermediate", "software-product>sap-btp", ...] }
```

The response is a flat array of tag slug strings. Every value in `primary_tag` and `tags` must appear in this array.

**Cached copy:** `hugo/data/tags.json` — use this when the endpoint is unavailable or for offline reference. It is regenerated at build time from the live endpoint.

---

## Alternative Lookups

If the primary endpoint is unreachable, use one of these fallbacks to inspect the taxonomy:

1. **CDS model via cds-mcp** — call `search_model` with `name: Tags` to query the `Tags` CDS entity and enumerate known tag slugs.

2. **Seed CSV files** — read `db/data/com.sap.developers.ims-*.csv` files in the project root. The relevant file typically matches `*Tags*.csv` or `*Tag*.csv`. These are the authoritative seed records loaded into the database at deploy time.

---

## Hard-Gate Rule

Tag validation is a **hard gate** — the skill rejects any frontmatter value that is not present in the taxonomy.

**Rules:**

1. Every value in `primary_tag` and every value in the `tags` array must exist in the tag slug list returned by `GET /build/tags`.

2. `tags[0]` (the first entry in the `tags` array) **must** be a level tag. Accepted values:
   - `tutorial>beginner`
   - `tutorial>intermediate`
   - `tutorial>advanced`

Violations cause the conversion to fail with a descriptive error before any file is written.

---

## Unavailable Fallback

If neither the `/build/tags` endpoint nor cds-mcp is reachable (e.g. no running CAP server, no `hugo/data/tags.json`):

1. The skill **warns** the author that taxonomy verification could not be performed.
2. The author is allowed to type tag values manually.
3. Each unverified value is flagged with a `# UNVERIFIED TAG` marker in the review report — it is never silently trusted.

**Example review report excerpt:**

```
primary_tag: software-product>sap-integration-suite   # UNVERIFIED TAG
tags:
  - tutorial>beginner
  - software-product>sap-integration-suite            # UNVERIFIED TAG
```

The author must verify these values against `hugo/data/tags.json` or the live endpoint before the PR is approved.
