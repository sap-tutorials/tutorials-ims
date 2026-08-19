// hugo-apps/src/petoberfest/lib/server.ts
import { csrfFetch } from '@shared/csrf-fetch';

export interface SlideEntry { id: string; petName: string; uploaderName: string; uploadedAt: string; }
export interface MyUpload { id: string; petName: string; moderation: string; uploadedAt: string; }

const API = '/petoberfest-api';

export function photoUrl(id: string, size: 'display' | 'thumb' = 'display'): string {
  return `${API}/photo/${encodeURIComponent(id)}?size=${size}`;
}

export async function probeAuth(): Promise<boolean> {
  try { const r = await fetch('/auth/user', { credentials: 'include' }); return r.ok; }
  catch (e) { console.warn('probeAuth: unexpected network error', e); return false; }
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
