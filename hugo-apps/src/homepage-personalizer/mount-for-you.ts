import { createApp } from 'vue';
import ForYouRow from './for-you-row.vue';

export interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}

export function mountForYou(root: HTMLElement | null, items: ForYouItem[]): void {
  if (!root) return;
  if (!items || items.length < 3) { root.hidden = true; return; }
  root.hidden = false;
  let target = root.querySelector<HTMLElement>('[data-vue-root]');
  if (!target) {
    target = document.createElement('div');
    target.setAttribute('data-vue-root', '');
    root.appendChild(target);
  }
  createApp(ForYouRow, { items }).mount(target);
}
