# Authoring branched missions

> **Audience:** Mission curators editing missions in the admin UI at `/admin-ui/#missions`.
> **Status:** v1 (issue #172). Step-level branches inside individual tutorials are covered in Authoring branched tutorials (PR 3, separate doc).

A mission is a sequence of tutorials. Most are **linear** — the learner does each in order. **Alt-groups** let you offer an alternative within a mission: the learner picks one of N tutorials at the same position, then continues on the linear backbone.

The classic example is a deployment fork:

> Tutorial 1 → Tutorial 2 → **Pick one: HANA Cloud or PostgreSQL** → Tutorial 4 → Tutorial 5

Both branches reach the same goal; the learner only needs to do one.

## How to author an alt-group

1. Open `/admin-ui/#missions` and select your mission.
2. Open the Path containing the items.
3. For each tutorial that should be part of the alt-group, set:
   - **Alt-group key** — a short identifier shared across the alt-group's members. Example: `deployment`. Letters, digits, dashes only.
   - **Alt-group label** — display text on the chip. Example: `HANA Cloud`. Required when key is set.
   - **Order** — the same value for every member of the alt-group. (This is how the system identifies them as alternatives.)
4. *(Optional)* **Alt-group condition** — a predicate that, when it evaluates true, causes the system to recommend this branch automatically.

That's it — save and the next build picks it up.

## Conditions (optional)

Predicates are tiny — only the following forms are allowed:

| Form | Example |
|---|---|
| `completed:<slug>` | `completed:node-getting-started` |
| `completedMission:<slug>` | `completedMission:btp-cap-onboarding` |
| `profile.<field> == '<value>'` | `profile.deployment == 'cloud'` |
| `profile.<field> in ['<a>','<b>']` | `profile.role in ['developer','architect']` |

You can combine with `&&` (or the keyword `and`), negate with `!`, and group with parentheses:

```
profile.deployment == 'cloud' && !completed:hana-intro
```

The profile fields are a fixed v1 vocabulary: `deployment`, `role`, `cloud`. New fields require a schema change.

If a learner's state matches **any** branch's condition, that branch is the recommendation. If multiple match, the **first** declared (lowest itemOrder; ties resolved by record ID) wins. If none match, the runtime ranker picks based on the learner's interest (their completed-tutorial centroid).

## What the learner sees

In the mission side-nav, alt-groups appear as a chip row:

```
Mission: BTP CAP onboarding
  ▸ Intro
  ▸ Getting started
  ▾ Deployment:  [HANA Cloud  ★]  [PostgreSQL]
  ▸ Verify
```

The recommended chip (★) is highlighted, but **all branches are always selectable** — the learner can override.

## Validation rules

The admin UI rejects bad shapes before they save:

- A condition that doesn't parse — you'll see a validation error referencing the line.
- An alt-group label without a key (or vice versa).

Single-member alt-groups are flagged at path-level save (curator can create one branch, save, create the second, save).

## Limits in v1

- **No nested alt-groups.** Alt-groups can't contain alt-groups.
- **No branch-to-mission joins.** A branch can't link to a different mission's content.
- **Profile vocabulary is fixed.** New profile fields require a code change.

These are all open in v2 — file an issue if you need them.

## See also

- [Branching paths design (issue #172)](https://github.com/sap-tutorials/tutorials-poc/blob/main/docs/superpowers/specs/2026-06-09-172-branching-paths-design.md) (internal repo path)
- Step-level branches inside one tutorial — Authoring branched tutorials (lands in PR 3)
- Branching cookbook with copy-paste examples — branching cookbook (lands after PR 3)
