// hugo-apps/src/petoberfest/lib/server.ts
import { csrfFetch } from '@shared/csrf-fetch';

export interface SlideEntry { id: string; petName: string; uploaderName: string; uploadedAt: string; }
export interface MyUpload { id: string; petName: string; moderation: string; uploadedAt: string; }

const API = '/petoberfest-api';

export function photoUrl(id: string, size: 'display' | 'thumb' = 'display'): string {
  return `${API}/photo/${encodeURIComponent(id)}?size=${size}`;
}

// `/auth/user` is the XSUAA-gated JSON identity endpoint (see xs-app.json).
// An `r.ok` check alone is NOT sufficient: for an anonymous browser the
// approuter answers the XSUAA route with HTTP 200 + an HTML login-redirect
// page (not a 401), so a bare `return r.ok` reports every anon visitor as
// signed in — which unhid the upload form for logged-out users. Mirror the
// canonical robust probe from homepage-personalizer/coordinator.ts: require a
// JSON content-type AND a truthy `authenticated` flag in the body.
export async function probeAuth(): Promise<boolean> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' });
    if (!r.ok) return false;
    if (!(r.headers.get('content-type') || '').includes('json')) return false;
    const body = await r.json();
    return !!body?.authenticated;
  } catch (e) { console.warn('probeAuth: unexpected network error', e); return false; }
}

export async function fetchSlideshow(slug: string): Promise<SlideEntry[]> {
  const r = await fetch(`${API}/slideshow(slug='${encodeURIComponent(slug)}')`, { credentials: 'include' });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.value ?? data) as SlideEntry[];
}

export async function fetchMyUploads(slug: string): Promise<MyUpload[]> {
  const r = await fetch(`${API}/myUploads(slug='${encodeURIComponent(slug)}')`, { credentials: 'include' });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.value ?? data) as MyUpload[];
}

// Author-maintained intro/instructions for the contest (issue #1911). Stored as
// Markdown on Petoberfests.intro; rendered to sanitized HTML client-side.
// Returns '' on any miss so the page degrades gracefully.
export async function fetchIntro(slug: string): Promise<string> {
  try {
    const r = await fetch(
      `${API}/Petoberfests?$filter=slug eq '${encodeURIComponent(slug)}'&$select=intro`,
      { credentials: 'include' },
    );
    if (!r.ok) return '';
    const data = await r.json();
    const rows = (data.value ?? data) as Array<{ intro?: string }>;
    const row = Array.isArray(rows) ? rows[0] : (rows as { intro?: string });
    return (row && row.intro) || '';
  } catch {
    return '';
  }
}

export interface UploadResult { id: string; awarded: boolean; moderation: string; }

const UPLOAD_TIMEOUT_MS = 60_000;

/** Base64-encode bytes in chunks (avoids btoa call-stack blowups on large images). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/**
 * Build an Error that always carries the HTTP status — and, for a non-JSON edge/CDN
 * response, any reference id from the error page — so an Akamai block is never silent.
 */
async function buildUploadError(r: Response): Promise<Error> {
  let text = '';
  try { text = await r.text(); } catch { /* body unreadable */ }

  let json: any = null;
  if (text) { try { json = JSON.parse(text); } catch { /* not JSON — likely a CDN HTML error page */ } }
  if (json && (json.message || json.error)) {
    return Object.assign(new Error(json.message || 'Upload failed.'), { code: json.error, status: r.status });
  }

  // Non-JSON body ⇒ the request was rejected by the edge before it reached our server.
  // Match the Akamai "Reference #<n>.<hex>.<ts>.<hex>" token; the leading \d+\. skips the
  // "&#32;" HTML entity that precedes it in the raw markup.
  const ref = text.match(/#\s*(\d+\.[\w.\-]+)/)?.[1];
  const detail = ref ? ` (reference ${ref})` : '';
  return Object.assign(
    new Error(`Upload failed (HTTP ${r.status})${detail}. This may be a network or CDN issue — please try again.`),
    { code: 'EDGE_ERROR', status: r.status },
  );
}

export async function uploadPet(slug: string, file: File, petName: string): Promise<UploadResult> {
  // JSON transport (not multipart/form-data): the same xsuaa + csrfFetch path used by
  // /chat/stream and /api/* islands, which survive the Akamai edge. Multipart binary
  // uploads were stalling/blocked at the CDN (issue: works on cfapps, silent on developers.sap.com).
  const bytes = new Uint8Array(await file.arrayBuffer());
  const photoBase64 = bytesToBase64(bytes);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let r: Response;
  try {
    r = await csrfFetch(`${API}/${encodeURIComponent(slug)}/upload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petName, filename: file.name, mimeType: file.type, photoBase64 }),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw Object.assign(
        new Error('Upload timed out — the network or CDN did not respond. Please try again.'),
        { code: 'TIMEOUT' },
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) throw await buildUploadError(r);
  return r.json();
}

export interface WithdrawResult { withdrawn: boolean; creditRevoked: boolean; }

// Owner-scoped takedown. POST (not DELETE) so it survives Akamai's bare-verb block in PROD.
export async function withdrawPet(slug: string, id: string): Promise<WithdrawResult> {
  const r = await csrfFetch(`${API}/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, id }),
    credentials: 'include',
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw Object.assign(new Error(err.error?.message || err.message || 'withdraw failed'), { status: r.status });
  }
  return r.json();
}
