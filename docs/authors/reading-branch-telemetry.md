# Reading branch telemetry

When you author a `[BRANCH BEGIN]` block (see [branched-tutorials.md](./branched-tutorials.md)), the platform records which branch each learner picks. This doc covers how to read that data and when to act on it.

## Where to find it

Open the **Missions Fiori app** → pick a mission → **Branch Performance** section near the bottom of the ObjectPage. The section is empty until learners have actually encountered a branch in your mission.

The same data is queryable via the **Analytics Explorer** (`/analytics-ui/`) — pick `AnalyticsBranchPerformance` or `AnalyticsBranchTopPick` from the entity list.

> **Two service surfaces, same data.** Admin users (Tutorials Admin role-collection) read these views via `/admin/analytics/AnalyticsBranchPerformance`. Authors (Tutorials Author role-collection) read the same views via `/author/AnalyticsBranchPerformance`. CAP cannot grant a single service to both audiences (`@requires` AND-combines with entity `@restrict`), so the platform projects each view into both services. The Mission ObjectPage uses the admin path; the `branch-staleness` lint rule uses the author path.

## What the columns mean

- **Total Decisions** — how many times the branch was rendered (one row per learner per visit).
- **Click Rate** — `clicks / total`. The fraction of renders where the learner explicitly chose a branch (vs walking past).
- **Follow Rate** — `followed / clicked`. Of the learners who clicked, how many took the recommendation. Low follow-rate means your recommendation logic is suggesting the wrong path.
- **Top Pick** — the most-picked branch and its share of all picks. Format: `hana (96%)`.
- **By Condition / By Ranker / By Default** — breakdown of how the recommendation was determined. "By Default" means no condition matched and no ranker was registered.
- **Via Joule / Via Page Load** — surface breakdown. High Joule share means learners are asking the chatbot for guidance instead of using the page.

## When to act on the staleness lint

The `branch-staleness` lint rule fires (severity: notice) when:

- The branch has been live ≥30 days
- It has ≥50 decisions logged
- One option has been picked **>95%** of the time

That's a strong signal that the branch isn't earning its keep — readers consistently pick the same path. Options:

1. **Inline the dominant path** and remove the branch entirely.
2. **Rephrase the choice** so the underrepresented path is more attractive (or more clearly relevant).
3. **Move the choice up or down** the tutorial — maybe learners are over-fixated by the time they reach it.

The lint never blocks the build. It's a quarterly review prompt, not a CI gate.

## Privacy and retention

Telemetry rows carry no learner-identifying data in the views — `BranchDecisions` itself includes `user_ID`, but the analytics views aggregate it away. Authors with the `Tutorial.Author` role collection see only the aggregated counts.

Raw `BranchDecisions` rows participate in the standard CAP `@PersonalData` anonymization cascade (see [docs/developers/architecture/anonymization-cascade.md](../developers/architecture/anonymization-cascade.md)).
