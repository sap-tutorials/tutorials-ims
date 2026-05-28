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
}

export type LauncherCtx = {
  slug: string;
  getActiveStep: () => number;
  getSteps: () => StepPayload[];
};

export function usePipLifecycle(ctx: LauncherCtx) {
  const pipWindow = ref<Window | null>(null);
  let channel: PipChannel | null = null;
  let themeObserver: MutationObserver | null = null;
  let stepListener: ((e: Event) => void) | null = null;
  let completeListener: ((e: Event) => void) | null = null;

  async function open(): Promise<boolean> {
    if (!isPipSupported()) return false;
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
    cloned.type = scriptTag.type || 'text/javascript';
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

    // Local send helper. The shared `OutgoingMessage` type is
    // `Omit<Envelope & DiscriminatedUnion, 'senderId' | 'source'>`, which TS
    // collapses into the intersection's common keys and rejects variant-
    // specific fields like `theme`/`stepIndex`. PipShell.vue dodges this
    // because .vue SFCs aren't checked by `tsc --noEmit`. Cast at the
    // boundary here so the launcher's plain .ts files compile cleanly.
    type Variant =
      | { type: 'pip:stepChange'; stepIndex: number }
      | { type: 'pip:complete'; stepIndex: number }
      | { type: 'pip:themeChange'; theme: 'light' | 'dark' }
      | { type: 'pip:closed' };
    const send = (msg: Variant): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel?.send(msg as any);
    };

    // Theme MutationObserver.
    themeObserver = new MutationObserver(() => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      send({ type: 'pip:themeChange', theme: t });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    // Receive step changes / completions from PiP and apply to main tab.
    channel.on((msg: PipMessage) => {
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
        send({ type: 'pip:stepChange', stepIndex: detail.stepIndex });
      }
    };
    document.addEventListener('tutorial:step-change', stepListener);

    // Listen for main-tab completion events → broadcast to PiP.
    completeListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.stepIndex === 'number') {
        send({ type: 'pip:complete', stepIndex: detail.stepIndex });
      }
    };
    document.addEventListener('tutorial:step-completed', completeListener);

    // Track PiP closure.
    win.addEventListener('pagehide', () => cleanup(), { once: true });
    return true;
  }

  function close(): void {
    pipWindow.value?.close();
    cleanup();
  }

  function cleanup(): void {
    pipWindow.value = null;
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
