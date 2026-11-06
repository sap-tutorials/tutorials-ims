# AGENTS.md

This is the AGENTS.md for the SAP Developers Tutorials platform codebase. AI coding agents (Claude Code, Cursor, Copilot, Aider) working in this repo should read this file and CLAUDE.md.

## Stack
- Hugo static site (hugo/) for tutorial pages, missions, groups
- CAP Node.js backend (srv/) on SAP HANA Cloud
- Vue 3 public-facing apps (hugo-apps/, app/display-app/)
- SAPUI5/Fiori Elements admin shell (app/admin-shell/)
- BTP Cloud Foundry deployment via MTA

## Authoritative guidance
**Read [CLAUDE.md](./CLAUDE.md) for the full project guide** — commands, architecture, gotchas, testing strategy. AGENTS.md is a pointer; CLAUDE.md is the canonical source.

## Quick conventions
- Hugo content under `hugo/content/tutorials/` is generated — never hand-edit. Modify parsers in `scripts/parsers/` or upstream tutorials in the `sap-tutorials` GitHub org.
- Tutorial HTML is served from HANA BLOBs, not static files. After Hugo build, run `npm run publish-content`.
- Run only **scoped** unit tests locally (`npm test -- <file-or-pattern>` or `npx vitest run <path>`); the full suite pegs the machine and runs in CI (local agent hooks block it). `npm run test:hybrid` requires `cf login`.
- Wrap noisy commands (build, deploy, tests, `cf logs`) in `scripts/quiet-run.sh` (bash) or `scripts/quiet-run.ps1` (PowerShell) to keep scrollback out of agent context.
- Use `cds-mcp` to look up CDS definitions and CAP API docs before editing CDS or CAP code.

## Out of scope for codebase agents
- Don't modify `hugo/content/tutorials/*.md` directly.
- Don't touch `gen/` (CAP build output) — regenerate via `cds build`.
- Don't bypass `@requires`/`@restrict` annotations on services.
