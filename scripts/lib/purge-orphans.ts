/**
 * Pure helpers for the --purge-orphans mode of scripts/publish-content.ts.
 *
 * Module is import-only — no top-level side effects, no HTTP, no fs.
 * Orchestration (env reading, fetch, exit codes) lives in publish-content.ts.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode
 */

/**
 * Compute the set of orphan slugs: server has it, local doesn't.
 *
 * Set membership only — never hash equality — so a corrupted/empty local
 * hash never causes a false-positive orphan. Drift slugs go through --heal.
 */
export function computeOrphans(serverSlugs: string[], localSlugs: Set<string>): string[] {
  return serverSlugs.filter(s => !localSlugs.has(s));
}

/**
 * Enforce the absolute cap. Returns null on pass; returns an error message on fail.
 * Uses <= (at-cap passes; over-cap fails) — matches spec wording "Refuse if orphans > N".
 */
export function enforceCap(orphanCount: number, capAbs: number): string | null {
  if (orphanCount <= capAbs) return null;
  return `Orphan count ${orphanCount} exceeds cap (${orphanCount} > ${capAbs} abs). ` +
         `Investigate fetch output before raising --purge-cap-abs.`;
}

/** Build the markdown block for $GITHUB_STEP_SUMMARY. */
export function formatStepSummary(opts: {
  mode: 'dry-run' | 'committed' | 'failed';
  serverCount: number;
  orphanCount: number;
  purged?: number;
  alreadyInactive?: number;
  notFound?: number;
  redirected?: number;
  redirectedSamples?: string[];
  version?: number;
  errorMessage?: string;
}): string {
  const lines = ['### 🧹 Orphan purge — full mode', ''];
  if (opts.mode === 'dry-run') {
    lines.push(`- **Dry run** — would have purged ${opts.orphanCount} slug(s)`);
    lines.push(`- Server slugs scanned: ${opts.serverCount}`);
    return lines.join('\n');
  }
  if (opts.mode === 'failed') {
    lines.push(`- **FAILED** — ${opts.errorMessage}`);
    lines.push(`- Server slugs scanned: ${opts.serverCount}`);
    lines.push(`- Orphans detected: ${opts.orphanCount}`);
    return lines.join('\n');
  }
  lines.push(`- Server slugs scanned: ${opts.serverCount}`);
  lines.push(`- Orphans detected:     ${opts.orphanCount}`);
  lines.push(`- Soft-deleted:         ${opts.purged ?? 0}`);
  if ((opts.redirected ?? 0) > 0) {
    const samples = (opts.redirectedSamples ?? []).slice(0, 5).join(', ');
    lines.push(`- Preserved (redirect): ${opts.redirected} — ${samples}`);
  }
  if ((opts.notFound ?? 0) > 0) {
    lines.push(`- ⚠️ Not found:        ${opts.notFound} (phantom rows — operator action required)`);
  }
  lines.push(`- Manifest version:     ${opts.version ?? 'unknown'}`);
  return lines.join('\n');
}
