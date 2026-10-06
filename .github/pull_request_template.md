<!--
Thanks for the PR! Please fill out the sections below. Delete any that don't apply.
Open against DEV — main is protected and has no direct-to-main path.
-->

## What & why

<!-- What does this change do, and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs
- [ ] Refactor / chore
- [ ] CI / build

## How tested

<!-- Show the actual verification, not just "tests pass". Which commands/envs? -->

- [ ] `npm test` (unit) green
- [ ] Hybrid tested against real HANA (`npm run test:hybrid`) — if backend logic changed
- [ ] Verified the actual behavior in a running environment (not only unit tests)
- [ ] e2e spec added/updated (for `app/**` or `hugo/**` UI changes)

## Deploy scope

<!-- Reviewers and deployers need to know what shipping this requires. -->

- [ ] Backend only (`srv/**`)
- [ ] + Content changes (requires content rebuild/publish)
- [ ] + Admin UI (`app/admin*/**`) — **requires a FULL deploy**, no `--skip-build`, no `-m` scoping
- [ ] + Frontend / Hugo (`hugo/**`, `hugo-apps/**`)
- [ ] MCP MTA (`tutorials-mcp`) — deployed separately

## Checklist

- [ ] Branched from `DEV`
- [ ] No secrets, credentials, or API keys committed
- [ ] CAP: used `cds.ql`/CQL (no raw SQL); services protected with `@requires`/`@restrict`
- [ ] Did not edit generated `hugo/content/tutorials/`
- [ ] Accessibility reviewed for UI changes (see [ACCESSIBILITY.md](../ACCESSIBILITY.md))
- [ ] Docs updated where behavior changed

## Notes for reviewers

<!-- Anything reviewers should pay attention to: risk areas, follow-ups, screenshots. -->
