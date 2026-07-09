import { createApp } from 'vue';
import ForYouRow from './for-you-row.vue';
import { readSessionCache } from './session-cache';

export interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}

// Human-readable "Because you're …" chip. Fires from the personalized-envelope
// profile so users see at a glance why the row surfaced these picks.
function becauseString(profile: { role?: string | null; deployment?: string | null; cloud?: string | null } | null): string {
  if (!profile) return '';
  const parts: string[] = [];
  if (profile.role) parts.push(profile.role);
  if (profile.deployment) parts.push(profile.deployment);
  if (profile.cloud) parts.push(`on ${profile.cloud.toUpperCase()}`);
  if (parts.length === 0) return '';
  return `Because you're a ${parts.join(' ')} developer`;
}

export function mountForYou(root: HTMLElement | null, items: ForYouItem[]): void {
  if (!root) return;
  if (!items || items.length < 3) { root.hidden = true; return; }
  root.hidden = false;

  // Populate the "because" chip from the cached envelope so the personalization
  // reason is visible next to the row title.
  const because = root.querySelector<HTMLElement>('[data-for-you-because]');
  if (because) {
    const cached = readSessionCache();
    because.textContent = becauseString(cached?.payload?.profile ?? null);
  }

  // Mount the cards INTO a dedicated child so the header (h2 + because chip)
  // survives Vue's `mount()` innerHTML replacement.
  let target = root.querySelector<HTMLElement>('[data-vue-root]');
  if (!target) {
    target = document.createElement('div');
    target.setAttribute('data-vue-root', '');
    root.appendChild(target);
  }
  createApp(ForYouRow, { items }).mount(target);
}
