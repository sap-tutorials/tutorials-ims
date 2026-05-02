import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// --- Pure functions (exported for testing) ---

export function discoverTutorials(hugoDir: string): Map<string, string> {
  const tutorialsDir = join(hugoDir, 'tutorials');
  const result = new Map<string, string>();

  let entries: string[];
  try {
    entries = readdirSync(tutorialsDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const indexPath = join(tutorialsDir, entry, 'index.html');
    try {
      const stat = statSync(indexPath);
      if (stat.isFile()) {
        result.set(entry, indexPath);
      }
    } catch {
      // not a tutorial directory
    }
  }

  return result;
}

export function computeLocalHashes(tutorials: Map<string, string>): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [slug, filePath] of tutorials) {
    const content = readFileSync(filePath);
    const hash = createHash('sha256').update(content).digest('hex');
    hashes.set(slug, hash);
  }
  return hashes;
}

export function computeDiff(
  local: Map<string, string>,
  remote: Record<string, string>
): string[] {
  const changed: string[] = [];
  for (const [slug, localHash] of local) {
    if (remote[slug] !== localHash) {
      changed.push(slug);
    }
  }
  return changed;
}

export function buildPayload(
  slugs: string[],
  tutorials: Map<string, string>
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const slug of slugs) {
    const filePath = tutorials.get(slug);
    if (!filePath) continue;
    const content = readFileSync(filePath);
    const compressed = gzipSync(content);
    payload[slug] = compressed.toString('base64');
  }
  return payload;
}

// --- CLI ---

interface PublishOptions {
  hugoDir: string;
  baseUrl: string;
  apiKey: string;
  trigger: string;
  hugoVersion: string;
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): PublishOptions {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  return {
    hugoDir: get('--hugo-dir', 'hugo/public'),
    baseUrl: get('--base-url', process.env.CAP_BASE_URL || 'http://localhost:4004'),
    apiKey: get('--api-key', process.env.CONTENT_API_KEY || ''),
    trigger: get('--trigger', `manual@${process.env.GITHUB_SHA?.slice(0, 7) || 'local'}`),
    hugoVersion: get('--hugo-version', ''),
    dryRun: has('--dry-run'),
    force: has('--force'),
    verbose: has('--verbose'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.apiKey) {
    console.error('Error: No API key. Set CONTENT_API_KEY env var or pass --api-key');
    process.exit(1);
  }

  const log = opts.verbose ? console.log : () => {};

  log(`Discovering tutorials in ${opts.hugoDir}...`);
  const tutorials = discoverTutorials(opts.hugoDir);

  if (tutorials.size === 0) {
    console.error('Error: No tutorials found. Did you run the Hugo build?');
    process.exit(1);
  }

  log(`Found ${tutorials.size} tutorials`);

  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

  let changed: string[];

  if (opts.force) {
    log('Force mode: publishing all tutorials');
    changed = [...localHashes.keys()];
  } else {
    log(`Fetching remote hashes from ${opts.baseUrl}/content/hashes...`);
    let remoteHashes: Record<string, string> = {};
    try {
      const res = await fetch(`${opts.baseUrl}/content/hashes`);
      if (res.ok) {
        remoteHashes = await res.json() as Record<string, string>;
      } else if (res.status === 503) {
        log('No active content version — will publish all');
      } else {
        console.error(`Warning: Failed to fetch remote hashes (HTTP ${res.status}), publishing all`);
      }
    } catch (err) {
      console.error(`Warning: Cannot reach ${opts.baseUrl}/content/hashes, publishing all`);
    }

    changed = computeDiff(localHashes, remoteHashes);
  }

  if (changed.length === 0) {
    console.log('No changes detected. Nothing to publish.');
    process.exit(0);
  }

  console.log(`${changed.length} of ${tutorials.size} tutorials changed`);

  if (opts.dryRun) {
    console.log('Dry run — would publish:');
    for (const slug of changed.sort()) {
      console.log(`  ${slug}`);
    }
    process.exit(0);
  }

  log('Building payload...');
  const startTime = Date.now();
  const payload = buildPayload(changed, tutorials);

  const body = JSON.stringify({
    trigger: opts.trigger,
    hugoVersion: opts.hugoVersion || undefined,
    files: payload,
  });

  const sizeMB = (Buffer.byteLength(body) / 1024 / 1024).toFixed(1);
  log(`Payload size: ${sizeMB} MB`);

  log(`Publishing to ${opts.baseUrl}/content/publish...`);
  const res = await fetch(`${opts.baseUrl}/content/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`Publish failed (HTTP ${res.status}): ${errBody}`);
    process.exit(1);
  }

  const result = await res.json() as {
    version: number;
    filesWritten: number;
    totalSizeBytes: number;
    durationMs: number;
  };
  const totalMs = Date.now() - startTime;

  console.log(`Published successfully:`);
  console.log(`  Version:    ${result.version}`);
  console.log(`  Files:      ${result.filesWritten}`);
  console.log(`  Size:       ${(result.totalSizeBytes / 1024 / 1024).toFixed(1)} MB (decompressed)`);
  console.log(`  Server:     ${result.durationMs} ms`);
  console.log(`  Total:      ${totalMs} ms`);
}

// Run CLI when executed directly
const isMain = process.argv[1]?.includes('publish-content');
if (isMain) {
  main().catch(err => {
    console.error('Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
