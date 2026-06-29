// hugo-apps/src/homepage-explainers/composables/usePopoverPosition.ts
import { ref, type Ref } from 'vue';

/**
 * Viewport-edge detection for a popover anchored to an element.
 * Returns reactive `placement` ('above' | 'below') and `alignment`
 * ('left' | 'center' | 'right') that the template binds to CSS classes.
 *
 * No external dep (FloatingUI overkill for our 320×280 popover).
 *
 * Spec: #759 §1.3 — popover auto-flips above on viewport-edge collision.
 */
export function usePopoverPosition(opts: {
  anchorEl: Ref<HTMLElement | null>;
  popoverWidth?: number;
  popoverHeight?: number;
}) {
  const placement = ref<'above' | 'below'>('below');
  const alignment = ref<'left' | 'center' | 'right'>('center');
  const popoverW = opts.popoverWidth ?? 320;
  const popoverH = opts.popoverHeight ?? 280;

  function recompute() {
    const el = opts.anchorEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    // Vertical: prefer below, flip above if not enough room.
    placement.value = (vh - rect.bottom < popoverH && rect.top > popoverH) ? 'above' : 'below';

    // Horizontal: center on anchor unless it would overflow.
    const anchorCenter = rect.left + rect.width / 2;
    const VIEWPORT_MARGIN_PX = 8;
    if (anchorCenter - popoverW / 2 < VIEWPORT_MARGIN_PX) {
      alignment.value = 'left';
    } else if (anchorCenter + popoverW / 2 > vw - VIEWPORT_MARGIN_PX) {
      alignment.value = 'right';
    } else {
      alignment.value = 'center';
    }
  }

  return { placement, alignment, recompute };
}
