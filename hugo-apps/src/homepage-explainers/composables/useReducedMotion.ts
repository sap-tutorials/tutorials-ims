// hugo-apps/src/homepage-explainers/composables/useReducedMotion.ts
import { ref, onMounted, onBeforeUnmount } from 'vue';

/**
 * Reactive prefers-reduced-motion: reduce media query.
 * SSR-safe: defaults to false on server / before mount.
 */
export function useReducedMotion() {
  const reduced = ref(false);
  let mql: MediaQueryList | null = null;
  const handler = () => { reduced.value = !!mql?.matches; };

  onMounted(() => {
    mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.value = mql.matches;
    mql.addEventListener('change', handler);
  });

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', handler);
  });

  return reduced;
}
