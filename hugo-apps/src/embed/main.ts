// hugo-apps/src/embed/main.ts
import { resolveEmbedParams } from './params';
import { createEmbedBridge, type BridgeHandle } from './bridge';
import { pickAutoMode } from './autocompact';

function isFramed(): boolean {
  try { return window.parent !== window || !!window.opener; } catch { return true; }
}

function applyEmbedMode(mode: string | null, reset: boolean): void {
  const html = document.documentElement;
  if (reset) { delete html.dataset.embed; try { localStorage.removeItem('embed'); } catch {} return; }
  if (mode === 'none' || mode === 'minimal' || mode === 'reader') {
    html.dataset.embed = mode;
    try { localStorage.setItem('embed', mode); } catch {}
  }
}

function gotoStep(n: number): void {
  if (!Number.isInteger(n) || n < 1) return;
  // Reuse tutorial.ts hash navigation (expand + scroll).
  location.hash = '#step-' + n;
}

function armPipOnFirstGesture(): void {
  // documentPictureInPicture.requestWindow() needs transient user activation,
  // so we cannot open on load. Trigger the existing launcher on the first
  // user gesture instead. The launcher button lives in #tutorial-pip-launcher.
  const launcher = document.getElementById('tutorial-pip-launcher');
  if (!launcher) return;
  const btn = () => launcher.querySelector<HTMLElement>('ui5-button, button');
  const fire = () => {
    const b = btn();
    if (b) b.click();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener('pointerdown', fire, true);
    window.removeEventListener('keydown', fire, true);
  };
  window.addEventListener('pointerdown', fire, true);
  window.addEventListener('keydown', fire, true);
}

(function init() {
  const res = resolveEmbedParams(location.search);
  const framed = isFramed();
  const auto = pickAutoMode({ framed, explicitMode: res.reset ? 'full' : res.mode, width: window.innerWidth });
  const effectiveMode = res.mode ?? auto;
  const active = framed || res.mode !== null || res.reset || res.pip;
  if (!active) return; // inert for normal visitors

  // Reflect resolved mode (pre-paint already handled the common path; this
  // covers set-embed messages and keeps localStorage in sync).
  applyEmbedMode(effectiveMode, res.reset);

  // Deep-link to a step once the tutorial DOM is present.
  if (res.step != null) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => gotoStep(res.step!), { once: true });
    } else {
      gotoStep(res.step);
    }
  }

  // Arm PiP auto-launch (never fires without a user gesture).
  if (res.pip) armPipOnFirstGesture();

  // Bridge — post to opener (window host) and parent (iframe host).
  const targets: Window[] = [];
  try { if (window.opener) targets.push(window.opener as Window); } catch {}
  try { if (window.parent && window.parent !== window) targets.push(window.parent); } catch {}

  let bridge: BridgeHandle | null = null;
  if (framed || res.pip || effectiveMode) {
    bridge = createEmbedBridge({ hostOrigin: res.hostOrigin, targets });
    const html = document.documentElement;
    const slug = html.dataset.pageSlug || '';
    const title = html.dataset.pageTitle || document.title;
    const stepCount = parseInt(html.dataset.stepCount || '0', 10) || 0;
    bridge.emitReady({ slug, title, stepCount });
  }

  // Inbound actions from the bridge.
  document.addEventListener('embed:goto', (e) => gotoStep((e as CustomEvent).detail?.stepIndex));
  document.addEventListener('embed:set-embed', (e) => {
    const m = (e as CustomEvent).detail?.mode;
    applyEmbedMode(m === 'full' ? null : m, m === 'full');
  });
  document.addEventListener('embed:set-theme', (e) => {
    const t = (e as CustomEvent).detail?.theme;
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
      document.documentElement.classList.toggle('dark', t === 'dark');
      try { localStorage.setItem('theme', t); } catch {}
    }
  });

  window.addEventListener('pagehide', () => bridge?.destroy(), { once: true });
})();
