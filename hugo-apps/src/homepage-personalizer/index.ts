import { boot } from './coordinator';

if (document.readyState === 'complete') {
  (window as any).requestIdleCallback
    ? (window as any).requestIdleCallback(() => boot())
    : setTimeout(boot, 50);
} else {
  window.addEventListener('load', () => {
    (window as any).requestIdleCallback
      ? (window as any).requestIdleCallback(() => boot())
      : setTimeout(boot, 50);
  }, { once: true });
}
