# For-You Row Curator Runbook

This document is for content curators managing the `HomepageForYouCandidates` pool that powers the "For you" row on the developer portal homepage.

**Admin surface:** `/admin-ui/#for-you`

---

## What the "For you" row does

When a signed-in user visits `/`, the homepage personalizer reads their learning preferences (`role`, `deployment`, `cloud`) and picks matching candidates from the `HomepageForYouCandidates` pool. The row appears between the verb spine (Row 2) and the events band (Row 3). It is hidden entirely if fewer than 3 candidates match the user's profile.

Users who are not signed in, or whose profiles match fewer than 3 candidates, never see the row.

---

## Where to manage candidates

1. Open `/admin-ui/#for-you` (requires admin role).
2. The list view shows: Title · Kind · Target · Persona tags · Weight · Active · Sort order · Updated.
3. Click a row to open the object page and edit all fields.
4. Press **Create** to add a new candidate.

---

## Healthy pool size

Keep **15–30 active candidates** at all times. This ensures every role combination (developer, architect, sysadmin, student) has at least 3 matching entries, which is the minimum the island requires before it shows the row.

If the pool drops below 15 active, some role/deployment combinations will see no row at all.

---

## Persona tags — required

**Every candidate must carry at least one persona tag.** A candidate with no persona tags never appears in the "For you" row, regardless of its `active` flag or weight. (Untagged entries are not shown — the "For you" row uses strict tag matching, unlike shelves which show untagged entries at default sort order.)

Tags follow the `<field>:<value>` grammar:

```
role:developer | role:architect | role:sysadmin | role:student
deployment:cloud | deployment:onprem
cloud:btp | cloud:aws | cloud:azure | cloud:gcp | cloud:alibaba | cloud:oracle | cloud:ibm
```

The admin UI `<ui5-multi-combobox>` for persona tags offers these values as suggestions. Unknown tags are rejected on save with a field-level error.

---

## Weight guidance

`personaWeight` controls how strongly a match is prioritised. Range: −10..+10. Default: 0.

| Weight | When to use |
|--------|-------------|
| +5..+7 | Strong match — content is highly specific to this role or cloud (e.g. an AWS-specific tutorial tagged `cloud:aws`) |
| +3..+4 | Good match — clearly relevant but not exclusive |
| 0      | Generic relevance — "everyone in this role would benefit" with no urgency |
| −1..−3 | Soft deprioritise — valid for this profile but less important than unweighted peers |

Avoid extreme values (±8..±10) unless the entry is uniquely important for that audience. Weight ties are broken by `sortOrder`, then `title`.

---

## `personaHidden` — when to exclude

Use `personaHidden` to hard-suppress a candidate for a specific audience even if another tag would otherwise match. Example: a beginner-focused mission tagged `role:student` in `personaTags` might also list `role:architect` in `personaHidden` to prevent it from showing to architects who happen to match on a cloud tag.

`personaHidden` is terminal: if any hidden tag matches the user's profile, the candidate is excluded regardless of other tags.

---

## The `active` flag

Set `active: false` to temporarily remove a candidate without deleting it. Inactive candidates are excluded from the API response. They remain visible in the admin list with their full configuration for re-activation.

---

## Broken-link indicator

The nightly link-health job checks `HomepageForYouCandidates` alongside `HomepageShelves`. If the resolved URL for a candidate returns a non-2xx response or times out, the candidate receives a `linkStatus: BROKEN` flag and is hidden from the API response. A red dot appears in the admin list for that row.

To resolve:

1. Open the candidate in the object page.
2. Correct the `targetSlug` or the resolved URL.
3. Save. The next nightly run clears the broken flag if the URL resolves correctly.

Candidates with `linkStatus: BROKEN` do not surface to users, even if they have valid persona tags and `active: true`.

---

## Curation checklist for a new BTP environment

When setting up a new environment (e.g. after a fresh MTA deploy to a new subaccount):

1. Open `/admin-ui/#for-you`.
2. Confirm at least 15 active rows are present.
3. Confirm each row has at least one persona tag.
4. Check the "Updated" column — if all rows are very old, the data may have migrated stale; trigger a fresh save on a representative row to verify the admin UI round-trip works.
5. After setting `HomepageConfig.personalizationEnabled = true`, visit `/` as a signed-in user with a known role and confirm the "For you" row appears with at least 3 cards.

---

## Cross-references

- Architecture: [docs/developers/architecture/homepage-personalization.md](../developers/architecture/homepage-personalization.md)
- Persona-tag vocabulary source: `srv/lib/branch/profile-fields.js`
- Manual test plan: [homepage-personalization-manual-tests.md](homepage-personalization-manual-tests.md)
