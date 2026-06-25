// scripts/install-qa-workflows.ts
//
// Installer for the per-repo `notify-qa.yml` workflow that fires
// `repository_dispatch` events into tutorials-ims when a *-Contribution
// repo is pushed.
//
// Scope: this script generates the workflow YAML from the committed template
// and (eventually) opens a PR per *-Contribution repo. It deliberately does
// NOT write the `TUTORIALS_POC_DISPATCH_TOKEN` secret — that is a one-time
// manual step (`gh secret set`) per repo, to keep the installer's blast
// radius narrow.
//
// CLI usage (once the openPr stub is wired up):
//   tsx scripts/install-qa-workflows.ts

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function generateNotifyYaml(): string {
  return readFileSync(
    join(__dirname, '..', '.github', 'workflows', 'notify-qa.yml.template'),
    'utf8'
  )
}

export type Repo = { name: string }
export type Fetcher = () => Promise<Repo[]>

export async function listContributionRepos(fetcher: Fetcher): Promise<string[]> {
  const repos = await fetcher()
  return repos.filter((r) => r.name.endsWith('-Contribution')).map((r) => r.name)
}

async function realFetcher(): Promise<Repo[]> {
  throw new Error('not implemented in unit tests')
}

// Intentional stub: actual GitHub REST/Octokit PR-opening is left for the
// operational follow-up. Unit tests do not exercise this path.
async function openPr(_repo: string, _yaml: string): Promise<string> {
  throw new Error('TODO during execution')
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('install-qa-workflows.ts') ||
    process.argv[1].endsWith('install-qa-workflows.js'))

if (isMainModule) {
  ;(async () => {
    const repos = await listContributionRepos(realFetcher)
    const yaml = generateNotifyYaml()
    for (const r of repos) {
      console.log(`Opening PR in ${r}...`)
      const url = await openPr(r, yaml)
      console.log(`  ${url}`)
    }
  })().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
