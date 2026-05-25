# Migrating `TUTORIALS_GITHUB_TOKEN` to a GitHub App

**Status:** Workflow change merged; awaiting org-admin App registration to activate.
**Driver:** SAP org PAT expiry policies are short, and PAT rotation is manual, error-prone, and tied to a single human account. A GitHub App resolves all three.

> 👉 **For the org-admin and repo-maintainer setup steps**, see [`github-app-setup.md`](../github-app-setup.md). This doc covers the engineering rationale, current state, and migration design.

## Current state

The token `TUTORIALS_GITHUB_TOKEN` (a classic PAT) is consumed in exactly four places:

| Where | Purpose | Fallback |
| --- | --- | --- |
| `.github/workflows/rebuild-content.yml:89` | `npm run fetch-tutorials` — discovery (GraphQL) + raw markdown + rules.vr | none |
| `.github/workflows/deploy.yml:56` | MTA build step | `github.token` (the per-job ephemeral token) |
| `scripts/parsers/github.ts:79` (`graphqlRequest`) | All GraphQL discovery + commit metadata | reads `GITHUB_TOKEN` first, then `TUTORIALS_GITHUB_TOKEN` |
| `scripts/parsers/github.ts:477` (`fetchRulesVr`) | Raw CDN reads of `*-Contribution` private repos | same env-var fallback |

All access targets a **single org**: `sap-tutorials`. The fetcher reads:

- Public tutorial repos (e.g. `cap-getting-started`) — could in principle work unauthenticated, but discovery via GraphQL still requires a token to avoid 5000 → 60/hr rate limit.
- Private companion repos `*-Contribution` (e.g. `abap-core-development-Contribution`) for `rules.vr` validation quizzes — these *do* require auth.

Build cadence is on-demand only (`workflow_dispatch` + tutorial-source repository_dispatch), so call volume is well under any rate limit. The PAT exists to (a) authenticate against private repos and (b) lift the rate-limit ceiling for batched discovery.

## Why a GitHub App is a strict upgrade

| Concern | Classic PAT today | GitHub App |
| --- | --- | --- |
| Token lifetime | Whatever the SAP org policy allows; manual rotation when it expires | 1 hour, **auto-issued per workflow run** |
| Scope | Bound to the user's account (all repos they can see) | Bound to the App's installation; per-repo + per-permission |
| Continuity | Tied to one human; departure breaks the build | Org-owned; survives any single account |
| Audit trail | Actions appear as the user | Actions appear as the App (clear bot identity) |
| Rate limit | 5000 req/hr per user | 5000 req/hr per installation, separate from human usage |
| Rotation pain | Manual: regen, paste into Actions secret | None — token is regenerated every run |

The "expires every N days, requires human action" failure mode that motivated this research **disappears entirely** with a GitHub App.

## Architecture

```text
┌─────────────────────────────────────────┐
│ GitHub App: "sap-tutorials-builder"     │
│   Owner: sap-tutorials org              │
│   Permissions: contents:read,           │
│                metadata:read             │
│   Installed on: sap-tutorials org       │
│     repos: tutorials* + *-Contribution  │
└──────────────┬──────────────────────────┘
               │
               │ APP_ID + PRIVATE_KEY (Actions secrets)
               ▼
┌─────────────────────────────────────────┐
│ rebuild-content.yml (per run)           │
│   step 1: actions/create-github-app-    │
│           token@v1                      │
│           → installation token (1h TTL) │
│   step 2: fetch-tutorials with token    │
│           in TUTORIALS_GITHUB_TOKEN     │
└─────────────────────────────────────────┘
```

The App is created once. Each workflow run mints a fresh token. No long-lived secret ever holds a usable GitHub access token — only the App's RSA private key (which mints tokens but is itself not a token).

## Implementation status

The workflow change is **already merged** in `.github/workflows/rebuild-content.yml`:

- A `Generate GitHub App token` step (uses `actions/create-github-app-token@v1`) gated on the repo variable `USE_GITHUB_APP == 'true'`.
- The `Fetch tutorials` step pulls `steps.app-token.outputs.token || secrets.TUTORIALS_GITHUB_TOKEN` — App token if generated, PAT otherwise.

This lets the migration land safely with no behaviour change and no parallel-workflow scaffolding. Activation is one repo-variable flip after the org admin completes App registration; rollback is the inverse.

**No code changes required.** `scripts/parsers/github.ts` already reads `GITHUB_TOKEN` first (falling back to `TUTORIALS_GITHUB_TOKEN`), and installation tokens are standard Bearer tokens — they work transparently for both `graphqlRequest()` and `fetchRulesVr()`.

`deploy.yml:56` is unchanged — its `secrets.TUTORIALS_GITHUB_TOKEN || github.token` fallback keeps working, and the MTA build step does not need GitHub-org-scoped credentials. Once the PAT is retired, the line can either be deleted (rely solely on `github.token`) or migrated the same way if private-repo access becomes necessary in that step.

## Cutover steps

The detailed admin + repo-maintainer runbook lives in [`github-app-setup.md`](../github-app-setup.md). At a glance:

1. Org admin registers `sap-tutorials-builder` App, generates private key, installs on org.
2. Repo maintainer adds `TUTORIALS_APP_ID` + `TUTORIALS_APP_PRIVATE_KEY` (and optionally `TUTORIALS_APP_INSTALLATION_ID`) as Actions secrets.
3. Repo maintainer sets repo variable `USE_GITHUB_APP=true`.
4. Manually trigger a rebuild and verify the `Generate GitHub App token` step runs.
5. After one successful unattended run: delete `TUTORIALS_GITHUB_TOKEN` secret and revoke the underlying PAT.

Rollback at any stage = set `USE_GITHUB_APP` to anything other than `true`. The PAT path remains intact until step 5.

## SAP-specific considerations

- **App ownership.** The App must be owned by the `sap-tutorials` org, not a personal account, so it survives any individual leaving SAP. This is the whole point — confirm the SAP GitHub admin team will register it under the org.
- **Approval process.** Internal SAP policy may require security/IT review before installing third-party-style Apps, even self-authored ones. Submit early; this is the long pole.
- **Fallback if Apps are blocked.** If org policy disallows custom Apps, the next-best step is a **fine-grained PAT** scoped to the specific repos with `Contents: Read`. That fixes the over-broad-scope problem of classic PATs but **does not** fix the rotation problem. Apps remain the strictly better target.
- **Webhook permissions.** Don't enable any. The App is a token-minting identity, not an event consumer. Less surface = less review friction.

## Risks & open questions

| Risk | Mitigation |
| --- | --- |
| App approval takes weeks at SAP | Start the conversation now; meanwhile keep PAT working. The migration is non-urgent — current build is healthy. |
| `*-Contribution` private repos sit in a different org | Verify before App registration. If yes, App needs install on both orgs (or two Apps). Confirmed today: all access is `sap-tutorials/*` so this should not apply. |
| Action `actions/create-github-app-token@v1` is a third-party action | It's GitHub-published (`actions` org), widely used, and the canonical pattern. Pin the major version (`@v1`), not `@latest`. |
| Private-key leakage in logs | The action masks the token output by default. Don't `echo` it. |

## Recommendation

Proceed. The work is small (one workflow step, three secrets, no code changes), the security gain is real (scoped + auto-rotated + no human dependency), and the SAP-specific pain that drove the question — short PAT expiry — vanishes by construction. Schedule it after the current Gap #4 work lands so the PAT path stays in place as fallback while the App is being approved.
