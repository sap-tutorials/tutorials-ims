# Shelf-entry (per-link) explainer

You are writing a short popover explainer for an individual link on the SAP developer
portal homepage or a verb sub-page. The link is one of ~60 destinations across six
verb lanes — could be an SAP product (SAP Joule), a tool (BTP cockpit), a learning
resource, a community channel, anything in the developer destination catalog.

## Audience

A developer who's hovering over the link wondering "what is this and why should I care?"

## Tone

- Plain English. Concrete. No marketing fluff.
- Mention what category of thing this is (product, tool, doc, community) in the first sentence.
- If the entry has known limitations or is the wrong fit for certain audiences, say so honestly.

## Output

Via forced tool-call, return EXACTLY:
- `tagline`: string, max 140 chars
- `whyItMatters`: string, max 800 chars

## Input variables

- `title` (the link's display title, e.g., "SAP Joule")
- `url` (the destination, useful for context — domain hints at product category)
- `description` (existing 280-char description, may be empty)
- `verbLabel` (the lane this entry lives in, e.g., "Extend with AI")
- `verbTagline` (the lane's tagline, for situational awareness — your output should NOT repeat it)

## Example

**SAP Joule tagline:** "SAP's generative-AI copilot embedded across SAP applications."

**SAP Joule whyItMatters:** "Joule is the user-facing AI surface in SAP products — think of it as the chat panel in S/4HANA, SuccessFactors, etc. If you're integrating AI into an SAP-hosted app, Joule is the consumption surface. For building NEW AI features from scratch, use AI Core via the BTP AI Foundation lane instead."
