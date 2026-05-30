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
}
export interface AppendResult { slugsAccepted: number; batchHash: string; totalSizeBytes: number }

export interface CommitInput { baseUrl: string; apiKey: string; sessionId: string }
export interface CommitResult {
  version: number; fileCount: number; totalSizeBytes: number;
  durationMs: number; alreadyActive: boolean;
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
