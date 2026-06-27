export interface BeginInput {
  baseUrl: string; apiKey: string;
  trigger: string; hugoVersion: string; expectedSlugCount: number;
}
export interface BeginResult { sessionId: string; version: number; expiresAt: string }

export interface AppendInput {
  baseUrl: string; apiKey: string;
  sessionId: string;
  files: Record<string, string>;
  metadata: Record<string, any>;
  bodyTexts: Record<string, string>;
  branchSpecs?: Record<string, any>;
  // PR #591: per-slug gzipped raw markdown for source-of-truth drift detection.
  // Map keyed by the SAME slug as `files`. Values are base64(gzip(rawMarkdownBytes)).
  // Optional + ignored by server when null/absent — back-compat with older
  // clients and with payload entries (__shell__, __nav__) that have no source.
  sources?: Record<string, string>;
}
export interface AppendResult { slugsAccepted: number; batchHash: string; totalSizeBytes: number }

export interface CommitInput { baseUrl: string; apiKey: string; sessionId: string }
export interface CommitResult {
  version: number; fileCount: number; totalSizeBytes: number;
  durationMs: number; alreadyActive: boolean;
  /** #672 — slugs whose incoming sourceHash matched a superseded version
   * and were carry-forwarded instead of committed. Always present, often `[]`. */
  rejectedReverts: string[];
  /** Carry-forward count from the prior ACTIVE manifest (existing field, now declared). */
  carriedForward?: number;
}

async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const err: any = new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.status = res.status;
    err.responseBody = detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function beginSession(i: BeginInput): Promise<BeginResult> {
  return postJson(`${i.baseUrl}/content/publish/begin`, i.apiKey, {
    trigger: i.trigger, hugoVersion: i.hugoVersion, expectedSlugCount: i.expectedSlugCount,
  });
}

export async function appendBatch(i: AppendInput): Promise<AppendResult> {
  return postJson(`${i.baseUrl}/content/publish/append`, i.apiKey, {
    sessionId: i.sessionId, files: i.files, metadata: i.metadata, bodyTexts: i.bodyTexts,
    branchSpecs: i.branchSpecs, sources: i.sources,
  });
}

export async function commitSession(i: CommitInput): Promise<CommitResult> {
  return postJson(`${i.baseUrl}/content/publish/commit`, i.apiKey, { sessionId: i.sessionId });
}

export async function abortSession({ baseUrl, apiKey, sessionId, reason }: {
  baseUrl: string; apiKey: string; sessionId: string; reason?: string;
}): Promise<{ aborted: boolean }> {
  try {
    await postJson<{ aborted: boolean }>(`${baseUrl}/content/publish/abort`, apiKey, { sessionId, reason });
    return { aborted: true };
  } catch {
    // Best-effort — even if the server is unreachable, the GC reaper will pick this up.
    return { aborted: false };
  }
}

export async function fetchRemoteHashes({ baseUrl }: { baseUrl: string }): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/content/hashes`);
  if (!res.ok) {
    if (res.status === 503) return {};
    const err: any = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<Record<string, string>>;
}

/**
 * Fetch the server's per-slug SOURCE markdown SHA-256 map (PR #591).
 * `/content/source-hashes` returns the same shape as `/content/hashes` but
 * keyed by sourceHash (markdown bytes) instead of contentHash (rendered HTML).
 * Slugs whose sourceHash is null (e.g. published before PR #591) are omitted
 * from the response — drift check skips those by design.
 *
 * Public-read like /content/hashes; no auth needed.
 */
export async function fetchRemoteSourceHashes({ baseUrl }: { baseUrl: string }): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/content/source-hashes`);
  if (!res.ok) {
    if (res.status === 503) return {};
    if (res.status === 404) {
      // Endpoint not yet deployed on this server. Treat as empty (no source
      // hashes known) so the caller can fall back or report a clean state.
      return {};
    }
    const err: any = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<Record<string, string>>;
}
