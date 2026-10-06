# Contributing

Thanks for contributing to the SAP Tutorial Platform — the hosting platform for [developers.sap.com](https://developers.sap.com). This guide covers how to get set up, make changes, and open a pull request.

> **Not editing code?** If you spotted a problem with a tutorial, mission, search, or anything else on the live site, open a [Site Feedback issue](../../issues/new?template=feedback.yml) instead — you don't need to clone the repo.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Getting started](#getting-started)
- [Branching & pull requests](#branching--pull-requests)
- [Commit messages](#commit-messages)
- [Testing](#testing)
- [Coding conventions](#coding-conventions)
- [What not to edit](#what-not-to-edit)
- [Security](#security)
- [Accessibility](#accessibility)

## Code of conduct

Be respectful and constructive. We follow the spirit of the [SAP Open Source Code of Conduct](https://github.com/SAP/.github/blob/main/CODE_OF_CONDUCT.md). Report unacceptable behavior to the maintainers.

## Ways to contribute

- **Report a site problem** — use the [Site Feedback issue template](../../issues/new?template=feedback.yml).
- **Fix a bug or add a feature** — see [Getting started](#getting-started) below.
- **Improve docs** — the `docs/developers/` tree is the source of truth for architecture and operations.
- **Fix tutorial content** — tutorial markdown is generated from the `sap-tutorials` GitHub org and is **not** editable here. See [What not to edit](#what-not-to-edit).

## Getting started

Node.js **22.12+** is required (`engines.node` in `package.json`).

```bash
npm install
npm run setup            # fresh worktree only: hugo-apps install + native rebuild
npm run fetch-tutorials  # required before dev/build; caches in .tutorial-cache/
npm run dev              # Hugo dev server at http://localhost:1313
```

For the CAP backend:

```bash
cds watch                # local CAP at http://localhost:4004 (in-memory SQLite)
npm run dev:hybrid       # CAP + approuter against real HANA (needs cds bind)
```

> **Fresh-worktree gotcha:** the global `ignore-scripts=true` npmrc skips native builds, so you **must** run `npm run setup` after `npm install` — otherwise `hugo-apps/node_modules` is empty and `better-sqlite3` won't build (tests hang/fail).

Full command list: `jq '.scripts' package.json`. Deep architecture docs live under [`docs/developers/`](docs/developers/).

## Branching & pull requests

- **Branch from `DEV`**, not `main`. `main` is protected and there is no direct-to-main hotfix path — even production fixes flow through `DEV`.
- Use a descriptive branch name: `fix/<short-desc>-<issue>`, `feat/<short-desc>`, `docs/<short-desc>`.
- **Always open a pull request** (`gh pr create`) — do not direct-merge. A code review is not a substitute for PR review.
- Keep PRs focused and reasonably small; one logical change per PR.
- Fill out the [pull request template](.github/pull_request_template.md) completely — especially the testing and deploy-scope sections.
- Link the issue the PR closes (`Closes #1234`).

### Before you push

```bash
npm test                 # unit tests (in-memory SQLite, fast)
```

CI runs unit tests, schema/API/content drift checks, secret scanning, and static guards on every PR. Make them green before requesting review.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>   (#<issue>)
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`. Example:

```
fix(content): lowercase slug before publish-payload comparison (#1234)
```

Reference the issue number where one exists.

## Testing

> **Test the actual thing before calling it done.** Green unit tests are necessary but not sufficient — verify the behavior you changed in the environment it actually runs in.

| Command | Scope | Notes |
| --- | --- | --- |
| `npm test` | Unit | In-memory SQLite, fast; run on every change |
| `npm run test:hybrid` | Hybrid | Real HANA via `cds bind --exec`; requires `cf login` |
| `npm run test:smoke` | Smoke | HTTP against a deployed env; set `SMOKE_BASE_URL`/`SMOKE_SRV_URL` |
| `npm run test:e2e` | E2E | Admin-UI Playwright smoke; post-deploy only, self-skips without `SMOKE_BASE_URL` |

User-facing UI changes (`app/**`, `hugo/**`) should come with a committed e2e spec where practical.

## Coding conventions

- **CAP / CDS:** use `cds.ql` or CQL — never raw SQL. Protect services with `@requires` / `@restrict`; never read `req.user` on an unprotected service. Don't depend on unpublished `@sap/` packages.
- **Secrets:** never commit credentials, API keys, or tokens. Use service bindings, env vars, or the BTP Credential Store. A secret-scan workflow will fail your PR.
- **HANA BLOBs:** never SELECT a BLOB alongside metadata in one CDS QL query (LOB locators expire) — use raw `db.run()`.
- **HTTP:** prefer Node's native `fetch` over third-party HTTP clients.
- **Node baseline:** Node 22.12+; keep code compatible with the CAP 10 defaults.

When in doubt, match the style of the surrounding code and consult the relevant doc in `docs/developers/`.

## What not to edit

- **`hugo/content/tutorials/`** — entirely generated by `fetch-tutorials`; your edits will be overwritten. Change `scripts/parsers/` or the source tutorial repos instead.
- **Published tutorial content** — never run `publish-content` from a workstation. Use the `rebuild-content.yml` GitHub workflow so changes pass CI validation.
- **Generated Hugo `data/` JSON** — regenerated by the build pipeline.

## Security

Never commit secrets. If you discover a security vulnerability, **do not** open a public issue — contact the maintainers privately. See the repository's security policy for responsible-disclosure details.

## Accessibility

This is a public-facing site with accessibility obligations. UI changes must meet the standards in [ACCESSIBILITY.md](ACCESSIBILITY.md) — keyboard operability, semantic markup, sufficient contrast, and visible focus. Review it before touching anything under `app/**` or `hugo/**`.
