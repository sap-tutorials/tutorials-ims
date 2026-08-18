# Skills

This folder publishes AI skills in the layout expected by the
[SAP AI Skills Library](https://github.com/SAP/ai-skills-library) so they can be
registered there and installed into Claude Code, Codex, Cursor, OpenCode, and
other agents via the `skills` CLI.

The library is a **registry**, not a code host: skill code stays here, in this
public repository, and is registered by opening a
["Register a New Skill"](https://github.com/SAP/ai-skills-library/issues/new?template=new-skill.yml)
issue that points at this repo. MCP servers are registered the same way — a
`SKILL.md` documents how to install/run the server.

## Layout

```
skills/
  <slug>/
    SKILL.md   # frontmatter: name + description (drives AI trigger matching)
```

## Published skills

| Slug | What it does |
|---|---|
| [`graphify`](graphify/SKILL.md) | Turn any folder (code, docs, papers, images) into a navigable knowledge graph with community detection and an audit trail. Wraps the third-party `graphifyy` package by [@safishamsi](https://github.com/safishamsi) (attribution preserved in the skill). |
| [`whats-new`](whats-new/SKILL.md) | Build/refresh a "What's New" digest from recently merged PRs across one or more GitHub repos. Self-contained (`gh`-based); works in any repo. |
| [`sap-tutorials-content`](sap-tutorials-content/SKILL.md) | Read SAP developer tutorial content from the public developers.sap.com API — catalog, navigation, tutorial HTML/JSON, search, and a ready-made anonymous MCP endpoint. Read-only, no auth. |

## Registering these with the SAP AI Skills Library

1. Confirm this repository is public on github.com (it is).
2. Confirm each skill has `skills/<slug>/SKILL.md` with `name` + `description`
   frontmatter (they do), author info (repo README / package.json), and a
   LICENSE (this repo is Apache-2.0).
3. Open a [Register a New Skill](https://github.com/SAP/ai-skills-library/issues/new?template=new-skill.yml)
   issue with this repo URL and a one-line description per skill:
   - `graphify — any input → knowledge graph → clustered communities → HTML + JSON + audit report`
   - `whats-new — build a "What's New" digest from recently merged PRs across GitHub repos`
   - `sap-tutorials-content — read SAP tutorial content (catalog, HTML/JSON, search, MCP) from developers.sap.com`

## Notes

- These skills are **independent of the tutorials platform build** — this folder
  is inert to the Hugo/CAP build and exists only for skills-registry discovery.
- Contributions to the library require Apache-2.0 licensing and DCO sign-off on
  the first PR; see the library's `CONTRIBUTING.md`.
