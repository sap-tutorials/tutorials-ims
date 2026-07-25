---
title: Joule Commands for Authors
description: A catalogue of what you can ask Joule to do — every feature the assistant supports, with example prompts you can type or adapt.
---

# Joule Commands for Authors

Joule is the in-page AI assistant. This page catalogues **everything you can ask it to do** — one entry per feature, each with example prompts you can copy, adapt, and share with your readers.

## How Joule "commands" actually work

Joule has **no slash commands**. The composer is a plain text box (placeholder *"Message Joule"*) — you talk to it in natural language, and Joule decides which of its underlying tools to run based on what you ask and where you are.

So the "commands" below are really **example prompts**. Two things shape what Joule can do at any moment:

1. **Where you are.** Joule registers a different tool set per page — a learner reading a tutorial, an admin in the Analytics Explorer, and a visitor on the Devtoberfest page all get different capabilities. See [Context matters](#context-matters-what-joule-can-do-where).
2. **Which features are switched on.** Most tools sit behind feature flags in the `ChatSettings` row. If a flag is off, Joule won't have that tool — asking for it will fall back to a plain answer. Admins manage these in [Joule chat admin settings](../developers/operations/joule-chat-admin-settings.md).

Everything Joule knows is scoped to the SAP tutorial corpus and a small set of related SAP documentation. It is not a general chatbot — off-topic questions get steered back to learning.

---

## Author &amp; admin commands

These are available when you open Joule **as an admin inside the Analytics Explorer or admin UI**. They are the closest thing Joule has to "author commands."

### Ask how the platform itself works

Search the platform's own repository documentation to answer "how does X work" questions about the tutorial system — the build pipeline, publishing, branching, roles, and so on.

> *"How does the content rebuild pipeline work?"*
>
> *"What role do I need to preview `*-Contribution` content?"*
>
> *"Explain how branched tutorials are recommended."*

Tool: `searchAdminDocs`. Keyword search over the platform docs; returns the most relevant passages.

### Run an analytics query in plain language

Ask about completion and start data across dimensions like tutorial, mission, group, tag, task type, event, and time (by week or month). Joule builds a **structured query** you can review in the chip builder — it never writes raw SQL.

> *"How many completions did the ABAP mission get in the last 30 days?"*
>
> *"Show me starts by tag for this week."*
>
> *"Top 10 tutorials by distinct users this month."*

Tools: `generateAnalyticsQuery` (turns your words into a reviewable QuerySpec) and `analyticsQuery` (runs a structured query directly). Cells covering fewer than 5 distinct users are suppressed for privacy.

### Explain an analytics result

Hand Joule a result sample and get a one-to-three-sentence plain-language summary — useful for pasting into a report or a PR description.

> *"Summarise these numbers for me."*
>
> *"What's the headline from this result?"*

Tool: `explainAnalyticsResult`.

> [!TIP]
> The admin analytics assistant lives in its own Joule panel inside the **Analytics Explorer** (`/analytics-ui/`), separate from the reader-facing panel. You need the `Admin` scope to see it. See [Analytics admin](analytics-admin.md).

---

## Learner-facing commands worth knowing

You author for readers, so it helps to know what Joule offers **them** on the public site. These shape how you write starter prompts and step help. Each is gated by its own feature flag.

### Find a tutorial

Search the catalogue by topic, tags, or type (tutorial, mission, or group). Results are annotated with the reader's own progress (new / in-progress / completed).

> *"Find a tutorial about CAP and HANA."*
>
> *"Show me beginner missions on ABAP."*

Tool: `searchTutorials` (always available).

### Search smarter with the knowledge graph

Expand a free-text query into related **knowledge-graph concepts** plus the most relevant tutorials, each with a short rationale — a better first step than a raw keyword search.

> *"What should I search for if I want to learn event-driven CAP?"*
>
> *"Find tutorials around RAP and clean core."*

Tool: `expandSearchConcepts` — flag `kgSearchExpansionEnabled`.

### Build a learning path

Produce an ordered sequence of tutorials toward a goal — "what do I do next" / "how do I get to X" — using shortest-path over the knowledge graph. Defaults the starting point to the reader's most recently completed tutorial.

> *"Give me a learning path to build a Fiori app on BTP."*
>
> *"What tutorial should I do next after finishing the CAP intro?"*

Tool: `findLearningPath` — flag `kgPathBetweenEnabled`.

### Explore a topic cluster

Ask **about a whole area** — "what's the AI cluster", "show me everything around RAP" — and get the cluster label, a one-line rationale, and its member tutorials.

> *"What's in the AI area?"*
>
> *"Show me everything around integration."*

Tool: `describeCommunity` — flag `communityPeersEnabled`.

### Find peers of the current tutorial

From the tutorial a reader is on, surface other tutorials in the same tightly-connected topic cluster — "what else is in this area."

> *"What else is like this tutorial?"*
>
> *"Other tutorials in this topic?"*

Tool: `findCommunityPeers` — flag `communityPeersEnabled`.

### Find related SAP content beyond tutorials

Pull in related external SAP content through the knowledge graph: learning journeys, blog posts, Discovery Center missions, videos, API docs, code samples, help docs, and community events.

> *"Any blog posts or videos related to this topic?"*
>
> *"Is there a learning journey for this?"*

Tool: `findRelatedContent` — flag `kgRelatedContentEnabled`.

### Explain a step

On a tutorial page, Joule already knows which tutorial and step the reader is on, so it can walk through what a step is doing and why — no pasting required. This powers the **"Help with this step"** button (the step FAB).

> *"Explain what this step is doing."*
>
> *"Why does this command fail?"*

Tool: `getRelevantSteps` (semantic vector search over step excerpts) — flag `ragEnabled`.

### Check submitted code

Grade a code snippet against a step's author-defined goal, returning a pass / partial / fail verdict. Joule uses this only when the reader has pasted code **and** named a tutorial slug plus step number.

> *"Check my code for step 3 of `create-a-cap-service`:"* (followed by the snippet)

Tool: `checkCode` — flag `codeCheckEnabled`. See [CODECHECK authoring](writing-tutorials.md) for how to define the goal a step is graded against.

### Get a branch recommendation

On a tutorial or mission with branching, Joule reports which branch is recommended for the reader and why. It returns the branching engine's existing recommendation — it does not decide on its own.

> *"Which path should I take here — cloud or on-prem?"*

Tool: `getBranchRecommendation` — flag `branchingEnabled`. See [Branched tutorials](branched-tutorials.md).

### Check personal progress

Fetch the signed-in reader's in-progress tutorials plus the slugs of completed tutorials, missions, and groups.

> *"What am I in the middle of?"*
>
> *"What have I completed so far?"*

Tool: `getUserProgress`.

### Devtoberfest info

On the Devtoberfest page, Joule answers from the authoritative event config — dates, rules, points, gameboard, activities, legal terms, videos, and live streams.

> *"When does Devtoberfest start?"*
>
> *"How do points work?"*

Tool: `getDevtoberfestInfo`.

---

## Context matters: what Joule can do where

Joule swaps its tool set depending on the page. If a capability is missing, it's usually because you're on a page that doesn't register it — or the feature flag is off.

| Where you are | Tools Joule registers |
| --- | --- |
| **Admin UI** (as admin) | `searchAdminDocs`, `analyticsQuery`, `generateAnalyticsQuery`, `explainAnalyticsResult`, plus the learner tools below |
| **Any tutorial / homepage / search** (learner) | `searchTutorials`, `getUserProgress`, and every flag-gated tool that is switched on |
| **Advocates page** | `searchTutorials`, `getUserProgress` |
| **Devtoberfest page** | `searchTutorials`, `getDevtoberfestInfo` only |

Flag-gated tools (`getRelevantSteps`, `checkCode`, `getBranchRecommendation`, `findLearningPath`, `expandSearchConcepts`, `findRelatedContent`, `findCommunityPeers`, `describeCommunity`) are only registered when their flag is on in the `ChatSettings` row.

---

## Opening Joule and pre-filling prompts

You can drive Joule from your own pages and links. This is how starter prompts and the step-help button work under the hood.

### Starter (suggested) prompts

Each page kind shows up to **three** suggested prompts above the composer. They are defined per page kind (`tutorial`, `tutorial-step`, `homepage`, `search`, `mission`, `group`, the `verb-*` explore pages, `advocates`, `generic`, and more) and support token substitution like `{heading}`, `{currentLabel}`, and `{branchLabel}`. This is the main lever authors have to shape the reader's first question.

### Open Joule from a link

Add query parameters to any page URL:

- `?joule=open` — opens the Joule panel automatically.
- `?joule_prompt=<text>` — opens the panel and immediately sends `<text>` as the reader's first message.

> Example: `/tutorials/create-a-cap-service?joule_prompt=Explain%20step%201`

### The command palette

Press <kbd>⌘K</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd> and choose **"Open Joule chat"** to open the panel from anywhere. The palette also offers navigation and per-step jump actions, but those are palette actions — not Joule prompts.

### Programmatic control

For custom widgets, `window.joule` exposes:

- `open(opts)` — open the panel.
- `openWithStepContext(ctx)` — open scoped to a specific tutorial step.
- `openWithMessage(arg)` — open and auto-send a message.
- `openWithPrefill(arg)` — open and pre-fill the composer **without** sending, so the reader edits and hits send.

---

## What Joule can't do

- **No content authoring or publishing.** Joule has no tools that write tutorials, trigger builds, resolve drift, or publish. Do that in the admin UI and the content pipeline — see [Center admin](center-admin.md) and [Writing tutorials](writing-tutorials.md).
- **No off-topic answers.** Ask about travel, generic coding puzzles, or the news and Joule declines and steers back to learning.
- **No raw SQL for analytics.** The analytics tools emit reviewable structured queries only.

## Related

- [Using Joule chat](../end-users/using-joule-chat.md) — the reader-facing overview.
- [Joule chat admin settings](../developers/operations/joule-chat-admin-settings.md) — how to toggle the feature flags referenced above.
- [Joule chat architecture](../developers/architecture/joule.md) — how the assistant, tools, and agent loop are wired.
- [Analytics admin](analytics-admin.md) — the Analytics Explorer and its Joule panel.
