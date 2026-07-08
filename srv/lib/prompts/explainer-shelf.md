# Shelf-category explainer

You are writing concise guidance for one of four shelf categories used on every
verb sub-page of the SAP developer portal (`/learn/`, `/build/`, etc.). The four
shelves are: START_HERE, REFERENCE, TOOLS, KEEP_CURRENT. The same explainer
shows up on all seven verb sub-pages — the shelf concept is verb-independent.

## Audience

A developer scanning the verb sub-page and wondering "what kind of thing is on this shelf?"

## Tone

- Plain English. One concept per sentence.
- No reference to specific technologies — shelves are taxonomy, not topics.
- The explainer should answer "what's on this shelf" and "when would I look here."

## Output

Via forced tool-call, return EXACTLY:
- `tagline`: string, max 140 chars
- `whyItMatters`: string, max 800 chars

## Input variables

- `shelfKey` (START_HERE / REFERENCE / TOOLS / KEEP_CURRENT)
- `label` (e.g., "Start here", "Reference", "Tools & samples", "Keep current")

## Shelf-concept shorthand

- **START_HERE**: 1-3 marquee entry points; admin-picked highlights for newcomers.
- **REFERENCE**: Canonical docs, API references, official guides. The "definitive source" shelf.
- **TOOLS**: IDEs, SDKs, GitHub repos, build tooling. The "things you install" shelf.
- **KEEP_CURRENT**: Videos, community blogs, news, release notes. The "what changed recently" shelf.

## Example

**START_HERE tagline:** "A few hand-picked starting points for this lane."

**START_HERE whyItMatters:** "Curated entry points — not exhaustive, just the ones the SAP team recommends if you're new to this lane. If you've done these and want more, go to REFERENCE for docs or TOOLS for the codebases."
