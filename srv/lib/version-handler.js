//
// GET /version — unauthenticated build-metadata endpoint (MTA versioning
// design, docs/superpowers/specs/2026-07-25-mta-versioning-design.md).
// Build facts (version, gitSha, builtAt) come from srv/version.json, written
// by the deploy pipeline before `mbt build`. The environment is resolved at
// REQUEST time from the CF space (resolveDeployEnvironment) — more truthful
// than baking an env label into the artifact, and reuses the existing helper.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveDeployEnvironment } from './deploy-environment.js';

const DEV_FALLBACK = { version: 'dev', gitSha: 'local', builtAt: null };
const DEFAULT_VERSION_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'version.json');

function readBuildFacts(versionFilePath) {
  try {
    const parsed = JSON.parse(readFileSync(versionFilePath, 'utf8'));
    return {
      version: typeof parsed.version === 'string' ? parsed.version : DEV_FALLBACK.version,
      gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : DEV_FALLBACK.gitSha,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : DEV_FALLBACK.builtAt,
    };
  } catch {
    return { ...DEV_FALLBACK };
  }
}

export function createVersionHandler({ versionFilePath = DEFAULT_VERSION_FILE, resolveEnv = resolveDeployEnvironment } = {}) {
  return function versionRoute(_req, res) {
    const facts = readBuildFacts(versionFilePath);
    const env = resolveEnv();
    res.status(200).json({ ...facts, environment: env.id });
  };
}

export const versionHandler = createVersionHandler();
