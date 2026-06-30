// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { useHoverIntent } from './useHoverIntent';

describe('useHoverIntent', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('fires onEnter after 250 ms hover', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    expect(onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(249);
    expect(onEnter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('cancels onEnter if leave happens before delay', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    vi.advanceTimersByTime(100);
    handleLeave();
    vi.advanceTimersByTime(500);
    expect(onEnter).not.toHaveBeenCalled();
    // onLeave only fires if onEnter previously fired.
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('fires onLeave only if onEnter has fired (cancel-then-leave is no-op)', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({ delayMs: 250, onEnter, onLeave });
    handleEnter();
    vi.advanceTimersByTime(300);
    expect(onEnter).toHaveBeenCalledTimes(1);
    handleLeave();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('reduces delay to 0 when reducedMotion ref is true', () => {
    const onEnter = vi.fn();
    const reducedMotion = ref(true);
    const { handleEnter } = useHoverIntent({ delayMs: 250, reducedMotion, onEnter });
    handleEnter();
    // With reduced motion, onEnter fires synchronously (or on next microtask)
    vi.advanceTimersByTime(0);
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onEnter if component unmounts while timer is pending', async () => {
    // Mount the composable inside a fake component so onBeforeUnmount fires.
    const { mount } = await import('@vue/test-utils');
    const { defineComponent, h } = await import('vue');
    const onEnter = vi.fn();
    const TestHost = defineComponent({
      setup() {
        const { handleEnter } = useHoverIntent({ delayMs: 250, onEnter });
        handleEnter();
        return () => h('div');
      },
    });
    const wrapper = mount(TestHost);
    // Timer is pending; unmount before it fires.
    vi.advanceTimersByTime(100);
    expect(onEnter).not.toHaveBeenCalled();
    wrapper.unmount();
    vi.advanceTimersByTime(500);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('idempotent on rapid re-enter — onEnter fires once per enter/leave cycle', () => {
    const onEnter = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({ delayMs: 250, onEnter });
    handleEnter();
    vi.advanceTimersByTime(300);
    expect(onEnter).toHaveBeenCalledTimes(1);
    // Second handleEnter without intervening leave: should NOT re-fire.
    handleEnter();
    vi.advanceTimersByTime(300);
    expect(onEnter).toHaveBeenCalledTimes(1);
    // After leave + enter again, fires once more.
    handleLeave();
    handleEnter();
    vi.advanceTimersByTime(300);
    expect(onEnter).toHaveBeenCalledTimes(2);
  });

  // #759 follow-up: hover-bridge regression — moving the cursor off the
  // ⓘ icon must not tear down the popover before the user can reach the
  // popover body / its scrollbar. The leave-delay window is the cushion;
  // a re-enter inside the window must cancel the pending close.
  it('defers onLeave by leaveDelayMs and cancels it on re-enter (hover-bridge)', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({
      delayMs: 250,
      leaveDelayMs: 180,
      onEnter,
      onLeave,
    });
    handleEnter();
    vi.advanceTimersByTime(250);
    expect(onEnter).toHaveBeenCalledTimes(1);
    // Pointer leaves the icon — onLeave should NOT fire immediately.
    handleLeave();
    vi.advanceTimersByTime(100);
    expect(onLeave).not.toHaveBeenCalled();
    // Cursor arrives at the popover body (simulated by a second enter on
    // a shared composable instance). The pending leave must be cancelled.
    handleEnter();
    vi.advanceTimersByTime(500);
    expect(onLeave).not.toHaveBeenCalled();
    // entered.value stayed true, so a fresh enter inside the leave-window
    // is a no-op (idempotent). onEnter is still 1.
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('fires onLeave after leaveDelayMs elapses with no re-enter', () => {
    const onEnter = vi.fn();
    const onLeave = vi.fn();
    const { handleEnter, handleLeave } = useHoverIntent({
      delayMs: 250,
      leaveDelayMs: 180,
      onEnter,
      onLeave,
    });
    handleEnter();
    vi.advanceTimersByTime(250);
    expect(onEnter).toHaveBeenCalledTimes(1);
    handleLeave();
    vi.advanceTimersByTime(179);
    expect(onLeave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
