export function initCompare(): void {
  document.querySelectorAll<HTMLElement>('[data-compare]').forEach(container => {
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]');
    const afterWrap = container.querySelector<HTMLElement>('.tut-compare__after-wrap');
    if (!slider || !afterWrap) return;
    const update = () => {
      const pct = Number(slider.value);
      afterWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    };
    update();
    slider.addEventListener('input', update);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCompare);
  } else {
    initCompare();
  }
}
