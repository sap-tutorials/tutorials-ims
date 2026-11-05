# Copilot instructions

**Read [CLAUDE.md](../CLAUDE.md) first.** It's the canonical project guide (commands, architecture, gotchas). [AGENTS.md](../AGENTS.md) has the short version. This file only covers what's specific to Copilot and to Windows/PowerShell.

## Shell (Windows / PowerShell)

- Most maintainers run PowerShell on Windows. Commands in CLAUDE.md are written in bash. Translate them, don't paste them as-is:
  - `export VAR=x` becomes `$env:VAR = 'x'`.
  - `&&` only chains native commands. Use `;` before PowerShell statements.
  - Use `git --no-pager`.
- Wrap noisy commands (`npm run build:all`, `mbt build`, `cf deploy`, `cf logs`, test runs) in **`scripts/quiet-run.ps1 <cmd…>`**. It's the PowerShell port of `scripts/quiet-run.sh`, with the same env knobs and log dir (`.quiet-logs/`). Open the full log only when the summary isn't enough.

## Tests

- Run only **scoped** unit tests locally: `npm test -- <file-or-pattern>` or `npx vitest run <path>`. A shared `preToolUse` hook ([.github/hooks/block-full-test-suite.json](hooks/block-full-test-suite.json)) denies the full suite. That suite runs in CI.
- Admin UI e2e (`npm run test:e2e`) runs only after a deploy and skips itself when `SMOKE_BASE_URL` is unset.

## Hard rules (summary, see CLAUDE.md for the details)

- Never edit generated output: `hugo/content/tutorials/`, `gen/`, `hugo/public/`, `approuter/static/`, `mta_archives/`.
- Never run `publish-content` from a workstation. Use `gh workflow run rebuild-content.yml`.
- Default to a feature branch and a PR (`.github/pull_request_template.md`). Confirm the deploy scope with the maintainer before you deploy.
- Don't stage unrelated working-tree changes. Hugo data files (`hugo/data/*.json`) are often regenerated locally.

## Tools

- **CDS/CAP:** Use the CAP MCP server (`search_model`, `search_docs`) before you edit `.cds` or CAP code.
- **UI5/Fiori:** Use the UI5 MCP server (`get_api_reference`, `run_ui5_linter`) for `app/admin*/**`.
- **Browser checks:** Use the `playwright-test` MCP server.
- **SAP / BTP / CF lookups:** Use the `sap-devs` MCP server. The `sap-devs` CLI must be on PATH.
- **MCP setup:** `.mcp.json` is personal and git-ignored because it can hold PATs. Start from `Copy-Item .mcp.json.example .mcp.json`. On Windows, if `npx` won't start, use `"command": "cmd", "args": ["/c", "npx", ...]`. The CAP and UI5 servers come from their VS Code extensions.
- Repo skills live in `.claude/skills/`, for example `tutorial-qa-to-prod`, `provision-tutorial-repo` and `whats-new`. Use one when it matches the task.
