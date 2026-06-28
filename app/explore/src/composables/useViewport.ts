import { ref, onMounted, onBeforeUnmount } from 'vue'

/**
 * Reactive viewport-mode tracker. Returns `isMobile` (true when viewport
 * matches `(max-width: 768px)`).
 *
 * Falls back to false in SSR / non-DOM contexts.
 */
export function useViewport() {
  const isMobile = ref(false)

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { isMobile }
  }

  const mql = window.matchMedia('(max-width: 768px)')
  isMobile.value = mql.matches

  function onChange(e: MediaQueryListEvent) {
    isMobile.value = e.matches
  }

  onMounted(() => {
    // Browser API: addEventListener('change', cb) is the modern shape;
    // addListener(cb) is the deprecated fallback for older Safari.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
    } else if (typeof (mql as any).addListener === 'function') {
      (mql as any).addListener(onChange)
    }
  })

  onBeforeUnmount(() => {
    if (typeof mql.removeEventListener === 'function') {
      mql.removeEventListener('change', onChange)
    } else if (typeof (mql as any).removeListener === 'function') {
      (mql as any).removeListener(onChange)
    }
  })

  return { isMobile }
}
