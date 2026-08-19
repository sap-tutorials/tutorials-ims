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

export interface UploadResult { id: string; awarded: boolean; moderation: string; }

export async function uploadPet(slug: string, file: File, petName: string): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('photo', file);
  fd.append('petName', petName);
  // Authenticated route → csrfFetch. Do NOT set Content-Type; the browser sets the multipart boundary.
  const r = await csrfFetch(`${API}/${encodeURIComponent(slug)}/upload`, { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw Object.assign(new Error(err.message || 'upload failed'), { code: err.error, status: r.status });
  }
  return r.json();
}
