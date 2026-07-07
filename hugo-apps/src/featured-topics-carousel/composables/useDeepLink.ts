import { onMounted, Ref } from 'vue';

export interface SlideRef {
  conceptSlug: string;
}

export interface UseDeepLinkOptions {
  slides: Ref<SlideRef[]>;
  onResolve: (index: number) => void;
}

/**
 * On mount: if the URL hash is `#featured/<slug>`, jump to the matching slide
 * and call `onResolve(index)`.
 *
 * Manual navigation from the carousel calls `history.replaceState` directly to
 * update the hash — that is handled in Carousel.vue's `jumpTo()`.
 */
export function useDeepLink(opts: UseDeepLinkOptions): void {
  onMounted(() => {
    if (typeof location === 'undefined') return;
    const m = location.hash.match(/^#featured\/(.+)$/);
    if (!m) return;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    const idx = opts.slides.value.findIndex((s) => s.conceptSlug === slug);
    if (idx >= 0) opts.onResolve(idx);
  });
}
