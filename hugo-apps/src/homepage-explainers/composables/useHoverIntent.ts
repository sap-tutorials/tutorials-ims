import { ref, onBeforeUnmount, type Ref } from 'vue';

/**
 * Hover-intent helper — delays onEnter callback to filter out
 * casual mouse-overs while still firing on intentional hover.
 *
 * Reduced-motion mode: bypasses delay entirely (instant fire).
 *
 * `leaveDelayMs` (optional, default 0) defers onLeave so a brief
 * pointer excursion through a non-anchor gap (e.g. between an ⓘ
 * trigger and an absolutely-positioned popover sitting 8 px away)
 * doesn't immediately tear down the open state. Re-entering during
 * the leave window cancels the pending onLeave — the consumer can
 * then call handleEnter() from a second hover-bridge element to
 * keep the popover alive while the cursor traverses to the
 * scrollbar or the popover body.
 *
 * Spec: #759 §1.3 trigger contracts table.
 *
 * Lifecycle: pending timers are cleared automatically on unmount so
 * onEnter / onLeave never fire on a dead component (would produce a
 * ghost popover if the consumer's callbacks mutate parent state).
 */
export function useHoverIntent(opts: {
  delayMs: number;
  leaveDelayMs?: number;
  reducedMotion?: Ref<boolean>;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  let enterTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  const entered = ref(false);

  function handleEnter() {
    // A re-enter during the leave-delay window cancels the pending
    // close — this is what lets the popover stay open as the cursor
    // crosses the gap into the popover body.
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
    // Idempotence: if already inside the hover window, don't re-arm.
    // Prevents double-fire of onEnter on rapid pointer churn.
    if (entered.value) return;
    if (enterTimer) clearTimeout(enterTimer);
    // Read reducedMotion per-call so the parent can toggle the media
    // query (or use a reactive override) without re-composing.
    const delay = opts.reducedMotion?.value ? 0 : opts.delayMs;
    enterTimer = setTimeout(() => {
      entered.value = true;
      opts.onEnter?.();
      enterTimer = null;
    }, delay);
  }

  function handleLeave() {
    if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
    if (!entered.value) return;
    const delay = opts.reducedMotion?.value ? 0 : (opts.leaveDelayMs ?? 0);
    if (delay === 0) {
      entered.value = false;
      opts.onLeave?.();
      return;
    }
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      entered.value = false;
      opts.onLeave?.();
      leaveTimer = null;
    }, delay);
  }

  onBeforeUnmount(() => {
    if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  });

  return { handleEnter, handleLeave, entered };
}
