import { ref, type Ref } from 'vue';

/**
 * Hover-intent helper — delays onEnter callback to filter out
 * casual mouse-overs while still firing on intentional hover.
 *
 * Reduced-motion mode: bypasses delay entirely (instant fire).
 *
 * Spec: #759 §1.3 trigger contracts table.
 */
export function useHoverIntent(opts: {
  delayMs: number;
  reducedMotion?: Ref<boolean>;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const entered = ref(false);

  function handleEnter() {
    if (timer) clearTimeout(timer);
    const delay = opts.reducedMotion?.value ? 0 : opts.delayMs;
    timer = setTimeout(() => {
      entered.value = true;
      opts.onEnter?.();
      timer = null;
    }, delay);
  }

  function handleLeave() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (entered.value) {
      entered.value = false;
      opts.onLeave?.();
    }
  }

  return { handleEnter, handleLeave, entered };
}
