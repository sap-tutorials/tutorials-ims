import { ref, onBeforeUnmount, type Ref } from 'vue';

/**
 * Hover-intent helper — delays onEnter callback to filter out
 * casual mouse-overs while still firing on intentional hover.
 *
 * Reduced-motion mode: bypasses delay entirely (instant fire).
 *
 * Spec: #759 §1.3 trigger contracts table.
 *
 * Lifecycle: a pending timer is cleared automatically on unmount so
 * onEnter never fires on a dead component (would produce a ghost
 * popover if the consumer's onEnter mutates parent state).
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
    // Idempotence: if already inside the hover window, don't re-arm.
    // Prevents double-fire of onEnter on rapid pointer churn.
    if (entered.value) return;
    if (timer) clearTimeout(timer);
    // Read reducedMotion per-call so the parent can toggle the media
    // query (or use a reactive override) without re-composing.
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

  onBeforeUnmount(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });

  return { handleEnter, handleLeave, entered };
}
