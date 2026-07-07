import { watchEffect, onBeforeUnmount, Ref } from 'vue';

export interface UseAutoAdvanceOptions {
  intervalMs: number;
  /** Reactive ref — auto-advance fires only when this is true */
  enabled: Ref<boolean>;
  /** Returns the container element for hover/focus listeners */
  container: () => HTMLElement | null;
  /** Called on each auto-advance tick */
  tick: () => void;
}

export function useAutoAdvance(opts: UseAutoAdvanceOptions): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hover = false;
  let focus = false;
  let hidden = typeof document !== 'undefined' ? document.hidden : false;

  const paused = () => hover || focus || hidden || !opts.enabled.value;

  function schedule(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!paused()) {
      timer = setTimeout(fire, opts.intervalMs);
    }
  }

  function fire(): void {
    if (!paused()) {
      opts.tick();
    }
    schedule();
  }

  const el = opts.container();

  const onMouseEnter = () => { hover = true; schedule(); };
  const onMouseLeave = () => { hover = false; schedule(); };
  const onFocusIn    = () => { focus = true; schedule(); };
  const onFocusOut   = () => { focus = false; schedule(); };
  const onVisibility = () => {
    if (typeof document !== 'undefined') hidden = document.hidden;
    schedule();
  };

  if (el) {
    el.addEventListener('mouseenter', onMouseEnter);
    el.addEventListener('mouseleave', onMouseLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  // Re-schedule whenever `enabled` reactive value changes.
  watchEffect(() => {
    // Access the reactive ref to register the dependency.
    void opts.enabled.value;
    schedule();
  });

  onBeforeUnmount(() => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (el) {
      el.removeEventListener('mouseenter', onMouseEnter);
      el.removeEventListener('mouseleave', onMouseLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  });
}
