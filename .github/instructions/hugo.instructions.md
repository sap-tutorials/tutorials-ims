---
applyTo: "hugo/**,hugo-apps/**,scripts/parsers/**,scripts/fetch-tutorials.ts"
---
# Hugo, islands and parsers

- `hugo/content/tutorials/` is entirely generated, so never edit it. Change `scripts/parsers/` instead, or the source tutorial repos in the `sap-tutorials` org.
- Tutorial HTML is served from HANA BLOBs, not from `hugo/public/`. Publish through `gh workflow run rebuild-content.yml`, never from a workstation.
- Deploys refuse a dirty tree under `hugo/assets/**` or `hugo/layouts/**` (Step 0.5). Commit or stash those files before deploying.
- `ignore-scripts=true` means `pre*` and `post*` hooks never run. The island manifest and page fallback are explicit `build:all` steps.
- Compare tutorial slugs with `.toLowerCase()`.
- Served tutorials render `<main>` and `<h1>`, not `<article>`. Keep that in mind when writing e2e selectors.
