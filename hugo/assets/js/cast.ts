// cast.ts — lazy-mount asciinema player on .tut-cast[data-tut-cast] elements.
// The asciinema-player is vendored as an IIFE (sets window.AsciinemaPlayer),
// so we inject a <script> tag at runtime rather than using import().

declare const AsciinemaPlayer:
  | { create(src: string, el: Element, opts: Record<string, unknown>): void }
  | undefined;

const PLAYER_JS = '/js/vendor/asciinema-player.min.js';
const PLAYER_CSS = '/js/vendor/asciinema-player.css';

function loadPlayerResources(): Promise<void> {
  return new Promise<void>((resolve) => {
    // If the player global already exists, nothing to load.
    if (typeof (window as unknown as Record<string, unknown>)['AsciinemaPlayer'] !== 'undefined') {
      resolve();
      return;
    }

    // Inject CSS link if not already present.
    if (!document.querySelector(`link[href="${PLAYER_CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = PLAYER_CSS;
      document.head.appendChild(link);
    }

    // Inject script tag if not already present.
    if (!document.querySelector(`script[src="${PLAYER_JS}"]`)) {
      const script = document.createElement('script');
      script.src = PLAYER_JS;
      script.onload = () => resolve();
      script.onerror = () => resolve(); // fail-open: resolve anyway
      document.head.appendChild(script);
    } else {
      // Script tag exists but global not yet set — wait for it.
      const existing = document.querySelector(`script[src="${PLAYER_JS}"]`) as HTMLScriptElement;
      existing.addEventListener('load', () => resolve(), { once: true });
    }
  });
}

function mount(el: HTMLElement): void {
  const src = el.dataset['tutCast'];
  if (!src) return;

  // Remove placeholder if present.
  const placeholder = el.querySelector('.tut-cast__placeholder');
  if (placeholder) placeholder.remove();

  // Build options from data attributes.
  const opts: Record<string, unknown> = {};
  const rows = el.dataset['rows'];
  const cols = el.dataset['cols'];
  const speed = el.dataset['speed'];
  const poster = el.dataset['poster'];
  const idleLimit = el.dataset['idleLimit'];

  if (rows !== undefined) opts['rows'] = Number(rows);
  if (cols !== undefined) opts['cols'] = Number(cols);
  if (speed !== undefined) opts['speed'] = Number(speed);
  if (poster !== undefined) opts['poster'] = poster;
  if (idleLimit !== undefined) opts['idleTimeLimit'] = Number(idleLimit);

  // Mark as mounted to guard against double-mount.
  el.dataset['castMounted'] = 'true';

  // AsciinemaPlayer is available as a global from the IIFE.
  (AsciinemaPlayer as NonNullable<typeof AsciinemaPlayer>).create(src, el, opts);
}

export async function initCast(opts?: { skipObserver?: boolean }): Promise<void> {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>('.tut-cast[data-tut-cast]:not([data-cast-mounted])')
  );

  if (elements.length === 0) return;

  const skipIO = opts?.skipObserver === true;

  if (skipIO || !('IntersectionObserver' in window)) {
    // Bypass IntersectionObserver — mount immediately (test seam + IO-absent fallback).
    await loadPlayerResources();
    for (const el of elements) {
      mount(el);
    }
    return;
  }

  // Lazy-mount via IntersectionObserver with a 200px root margin so the
  // player loads slightly before scrolling into view.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const target = entry.target as HTMLElement;
        void loadPlayerResources().then(() => mount(target));
      }
    },
    { rootMargin: '200px' }
  );

  for (const el of elements) {
    observer.observe(el);
  }
}

// Auto-init when the script is loaded by the page.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void initCast({}));
} else {
  void initCast({});
}

// Test seam — exported for unit tests only.
export const __test__ = { loadPlayerResources, mount };
