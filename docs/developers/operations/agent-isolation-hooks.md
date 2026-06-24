# Git hooks for agent isolation

## What

This project enforces a worktree-isolation contract for parallel agents via two git hooks under [scripts/git-hooks/](../../../scripts/git-hooks/):

- **`pre-commit`** — refuses commits to feature branches inside the PRIMARY worktree (`d:/projects/tutorials-poc/`). Forces parallel agents to commit from `.claude/worktrees/<name>/`.
- **`post-checkout`** — prints a loud warning at the moment a feature branch is checked out in the primary tree, so the offending agent can switch course immediately (before any edits land).

Both hooks auto-bypass when running in any `.claude/worktrees/*` directory. The `main` branch is always exempt from `pre-commit` (intended for human-driven hotfixes).

## Why

Parallel agents in this repo share the primary worktree's working directory by default. When two agents both check out feature branches in the primary tree, one agent's edits silently overwrite the other's. Symptoms include:

- Files reverting between Read calls
- Branch slipping between sessions
- Commits landing on the wrong branch
- Stashes containing unrelated work
- Tests passing or failing nondeterministically

The 2026-06-24 sessions saw all of these — parser changes leaking into a credstore PR, validation test edits lost mid-session, the active branch silently switching from `fix/validation-keep-answer-visible-on-correct` to `feat/secrets-credstore-first`. The root cause was always the same: another agent ran `git checkout <branch>` in the primary tree.

Memories that document the failure mode:

- `feedback_parallel_agents_worktrees` — Each parallel agent gets its own worktree
- `feedback_branch_slip_after_long_session` — HEAD silently reverts; re-issue checkout with commit
- `feedback_subagent_writes_can_leak_to_parent_repo` — Fallback writes land in parent

The hooks are the enforcement that prevents the failure, not just a doc telling agents to behave.

## How to install

The installer is wired into `npm run setup` (which devs already run after cloning):

```bash
npm install
npm run setup        # installs hooks via scripts/install-git-hooks.sh
```

Manual install (or re-install after editing the hook scripts):

```bash
sh scripts/install-git-hooks.sh
# → [install-git-hooks] installed N hook(s) into <git-common-dir>/hooks
```

The installer uses `git rev-parse --git-common-dir` so it works from any worktree — hooks always land in the primary tree's `.git/hooks/`, where they apply to every checkout in the repo.

## How to bypass (escape hatches)

### One-off commit on a feature branch in the primary tree

```bash
AGENT_ISOLATION_BYPASS=1 git commit -m "..."
```

Use this when you're a human and you have a reason (debugging the hook itself, urgent hotfix). The hook logs the bypass so it's visible in CI / pre-push review.

### Disable the hook entirely (rare)

```bash
# Delete just the pre-commit hook (post-checkout still warns)
rm .git/hooks/pre-commit

# Or skip the project setup step
git config --local core.hooksPath /dev/null
```

If you find yourself disabling regularly, the right answer is almost always "set up a worktree" — `git worktree add .claude/worktrees/<name>` takes 2 seconds.

## How the hooks decide whether to fire

Both hooks ask three questions in this order:

1. **Are we in a `.claude/worktrees/*` directory?** → auto-allow (this is the correct path).
2. **Are we on `main`?** → auto-allow (the primary tree is the canonical place to commit to main).
3. **Is `AGENT_ISOLATION_BYPASS=1` set?** (pre-commit only) → log + allow.

Otherwise: pre-commit refuses with a multi-line explanation; post-checkout warns loudly but doesn't block (git doesn't allow blocking checkout).

## Adding more hooks

Drop new hook scripts under [scripts/git-hooks/](../../../scripts/git-hooks/) with the standard git hook names (`pre-push`, `commit-msg`, `pre-rebase`, etc.). The installer recognizes those names automatically — no install-script edit needed. The whitelist of recognized names is in `install-git-hooks.sh:31`.

Make scripts executable in a way that survives Windows checkout:

```bash
git update-index --chmod=+x scripts/git-hooks/<new-hook>
```

(git-bash's `chmod` doesn't always stick on Windows; `git update-index --chmod` records the executable bit in the index.)

## Diagnostics: "my commit was refused but I'm sure I'm in a worktree"

```bash
git rev-parse --show-toplevel        # this is what the hook checks
git rev-parse --git-common-dir       # primary tree's .git, even from a worktree
git worktree list                    # all registered worktrees
```

If `--show-toplevel` is a path UNDER `.claude/worktrees/`, the hook auto-passes — if it's still refusing, the hook scripts may be stale (re-run `sh scripts/install-git-hooks.sh`) or another `core.hooksPath` is overriding (`git config --get core.hooksPath`).

## See also

- [docs/developers/operations/live-probing.md](live-probing.md) — sibling pattern: probe live state before assuming
- [docs/developers/reference/vue-islands-gotchas.md](../reference/vue-islands-gotchas.md) — discovered failure modes; this doc is the same shape for git/agent ops
