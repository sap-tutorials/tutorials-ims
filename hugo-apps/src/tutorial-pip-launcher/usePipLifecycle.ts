// hugo-apps/src/tutorial-pip-launcher/usePipLifecycle.ts
import { ref, onBeforeUnmount } from 'vue';
import { createPipChannel, type PipChannel } from '../shared/pip-channel';
import { loadPipMode } from '../shared/pip-storage';
import type { StepPayload, PipMessage } from '../shared/pip-types';

export function isPipSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

export function cloneStylesIntoDocument(src: Document, dest: Document): void {
  // <link rel="stylesheet"> + <link rel="preconnect" for fonts> + <style>
  const links = src.head.querySelectorAll('link[rel="stylesheet"], link[rel="preconnect"], link[rel="preload"]');
  links.forEach(node => dest.head.appendChild(node.cloneNode(true)));
  const styles = src.head.querySelectorAll('style');
  styles.forEach(node => dest.head.appendChild(node.cloneNode(true)));
  injectPipBaseStyles(dest);
}

// Base reset applied to the PiP document itself — the host <html>/<body> are
// outside any Vue component, so scoped styles can't reach them. Keeps the PiP
// window flush with no scrollbars on the chrome and lets PipShell's flex column
// fill the viewport. Idempotent: skip if already injected.
export function injectPipBaseStyles(dest: Document): void {
  if (dest.getElementById('pip-base-styles')) return;
  const style = dest.createElement('style');
  style.id = 'pip-base-styles';
  style.textContent = `
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    body { font-family: var(--sapFontFamily, '72', '72full', Arial, Helvetica, sans-serif); background: var(--sapBaseColor, #fff); color: var(--sapTextColor, #32363a); }
    #tutorial-pip-mount { height: 100%; display: flex; flex-direction: column; }
  `;
  dest.head.appendChild(style);
}

export type LauncherCtx = {
  slug: string;
  getActiveStep: () => number;
  getSteps: () => StepPayload[];
};

export function usePipLifecycle(ctx: LauncherCtx) {
  const pipWindow = ref<Window | null>(null);
  let channel: PipChannel | null = null;
  let channelOff: (() => void) | null = null;
  let themeObserver: MutationObserver | null = null;
  let stepListener: ((e: Event) => void) | null = null;
  let completeListener: ((e: Event) => void) | null = null;
  let opening = false;

  async function open(): Promise<boolean> {
    if (!isPipSupported()) return false;
    if (pipWindow.value || opening) return false;
    opening = true;
    try {
      const mode = loadPipMode();
      const dims = mode === 'full' ? { width: 480, height: 720 } : { width: 480, height: 140 };
      let win: Window;
      try {
        win = await (window as any).documentPictureInPicture.requestWindow(dims);
      } catch {
        return false;
      }

      cloneStylesIntoDocument(document, win.document);
      // Mirror initial theme.
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      win.document.documentElement.dataset.theme = theme;
      if (theme === 'dark') win.document.documentElement.classList.add('dark');

      // Drop mount node.
      const mount = win.document.createElement('div');
      mount.id = 'tutorial-pip-mount';
      win.document.body.appendChild(mount);

      // Inject the bundle into the PiP window. We piggy-back on the same
      // /js/tutorial-pip.js that was loaded into the main tab — but only the
      // PiP window's `globalThis` will have `__mountTutorialPip` if we load
      // the script there. Easiest path: copy the <script> tag the main page
      // already includes.
      const tagSelector = 'script[src*="/js/tutorial-pip.js"]';
      const scriptTag = document.querySelector<HTMLScriptElement>(tagSelector);
      if (!scriptTag) {
        win.close();
        return false;
      }
      const cloned = win.document.createElement('script');
      cloned.src = scriptTag.src;
      cloned.type = scriptTag.type || 'module';
      cloned.onload = () => {
        const mountFn = (win as any).__mountTutorialPip;
        if (mountFn) {
          mountFn(win.document, {
            slug: ctx.slug,
            steps: ctx.getSteps(),
            initialStepIndex: ctx.getActiveStep(),
            initialMode: mode,
          });
        }
      };
      win.document.body.appendChild(cloned);

      pipWindow.value = win;
      channel = createPipChannel(ctx.slug, 'main');

      // Theme MutationObserver.
      themeObserver = new MutationObserver(() => {
        const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        channel?.send({ type: 'pip:themeChange', theme: t });
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'class'],
      });

      // Receive step changes / completions from PiP and apply to main tab.
      channelOff = channel.on((msg: PipMessage) => {
        switch (msg.type) {
          case 'pip:stepChange':
            // Scroll the main tab to that step.
            {
              const node = document.querySelector<HTMLElement>(`.tutorial-step[data-step="${msg.stepIndex}"]`);
              node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            break;
          case 'pip:complete':
            // Update U11 progress bar UI without re-fetching.
            {
              const step = document.querySelector<HTMLElement>(`.tutorial-step[data-step="${msg.stepIndex}"]`);
              step?.classList.add('completed');
              const tocItem = document.querySelector<HTMLElement>(`.step-toc-item[data-toc-step="${msg.stepIndex}"]`);
              tocItem?.classList.add('completed');
            }
            break;
          case 'pip:closed':
            // PiP window has shut down — clean up.
            cleanup();
            break;
        }
      });

      // Listen for U11 step-change events in main tab → broadcast to PiP.
      stepListener = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail && typeof detail.stepIndex === 'number') {
          channel?.send({ type: 'pip:stepChange', stepIndex: detail.stepIndex });
        }
      };
      document.addEventListener('tutorial:step-change', stepListener);

      // Listen for main-tab completion events → broadcast to PiP.
      completeListener = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail && typeof detail.stepIndex === 'number') {
          channel?.send({ type: 'pip:complete', stepIndex: detail.stepIndex });
        }
      };
      document.addEventListener('tutorial:step-completed', completeListener);

      // Track PiP closure.
      win.addEventListener('pagehide', () => cleanup(), { once: true });
      return true;
    } finally {
      opening = false;
    }
  }

  function close(): void {
    pipWindow.value?.close();
    cleanup();
  }

  function cleanup(): void {
    pipWindow.value = null;
    channelOff?.();
    channelOff = null;
    channel?.close();
    channel = null;
    themeObserver?.disconnect();
    themeObserver = null;
    if (stepListener) document.removeEventListener('tutorial:step-change', stepListener);
    if (completeListener) document.removeEventListener('tutorial:step-completed', completeListener);
    stepListener = null;
    completeListener = null;
  }

  onBeforeUnmount(cleanup);

  return { pipWindow, open, close };
}
