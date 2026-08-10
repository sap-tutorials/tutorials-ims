import { isOriginAllowed, DEFAULT_ALLOWED_ORIGIN_PATTERNS } from './origin';

export interface BridgeDeps {
  hostOrigin: string | null;
  allowedPatterns?: string[];
  targets: Window[];
  doc?: Document;
  win?: Window;
}

export interface BridgeHandle {
  emitReady(info: { slug: string; title: string; stepCount: number }): void;
  emitCompleted(): void;
  destroy(): void;
}

type OutMsg = Record<string, unknown> & { type: string };

export function createEmbedBridge(deps: BridgeDeps): BridgeHandle {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const patterns = deps.allowedPatterns ?? DEFAULT_ALLOWED_ORIGIN_PATTERNS;
  const selfOrigin = win.location?.origin;

  // Post target: the validated host origin if we have one; otherwise skip
  // posting (we never fall back to "*").
  function post(msg: OutMsg): void {
    if (!deps.hostOrigin) return;
    if (!isOriginAllowed(deps.hostOrigin, patterns, selfOrigin)) return;
    for (const t of deps.targets) {
      try { t.postMessage(msg, deps.hostOrigin); } catch { /* target gone */ }
    }
  }

  const onStepChange = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.stepIndex === 'number') {
      post({ type: 'sap:tutorial:step-change', slug: currentSlug, stepIndex: d.stepIndex });
    }
  };
  const onStepCompleted = (e: Event) => {
    const d = (e as CustomEvent).detail;
    // tutorial.ts dispatches { stepNumber } — normalize to stepIndex on the wire.
    const idx = d && typeof d.stepNumber === 'number' ? d.stepNumber
      : (d && typeof d.stepIndex === 'number' ? d.stepIndex : null);
    if (idx != null) {
      post({ type: 'sap:tutorial:step-completed', slug: currentSlug, stepIndex: idx });
      // Auto-emit whole-tutorial completion when the final step is completed.
      // Only when stepCount is known (>0); otherwise the island calls
      // emitCompleted() explicitly.
      if (currentStepCount > 0 && idx === currentStepCount) {
        post({ type: 'sap:tutorial:completed', slug: currentSlug });
      }
    }
  };

  const onMessage = (e: MessageEvent) => {
    if (!isOriginAllowed(e.origin, patterns, selfOrigin)) return;
    const data = e.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('sap:tutorial:')) return;
    switch (data.type) {
      case 'sap:tutorial:goto':
        if (typeof data.stepIndex === 'number') {
          doc.dispatchEvent(new CustomEvent('embed:goto', { detail: { stepIndex: data.stepIndex } }));
        }
        break;
      case 'sap:tutorial:set-embed':
        if (typeof data.mode === 'string') {
          doc.dispatchEvent(new CustomEvent('embed:set-embed', { detail: { mode: data.mode } }));
        }
        break;
      case 'sap:tutorial:set-theme':
        if (data.theme === 'light' || data.theme === 'dark') {
          doc.dispatchEvent(new CustomEvent('embed:set-theme', { detail: { theme: data.theme } }));
        }
        break;
    }
  };

  let currentSlug = '';
  let currentStepCount = 0;

  doc.addEventListener('tutorial:step-change', onStepChange);
  doc.addEventListener('tutorial:step-completed', onStepCompleted);
  win.addEventListener('message', onMessage);

  return {
    emitReady(info) {
      currentSlug = info.slug;
      currentStepCount = info.stepCount;
      post({ type: 'sap:tutorial:ready', slug: info.slug, title: info.title, stepCount: info.stepCount });
    },
    emitCompleted() {
      post({ type: 'sap:tutorial:completed', slug: currentSlug });
    },
    destroy() {
      doc.removeEventListener('tutorial:step-change', onStepChange);
      doc.removeEventListener('tutorial:step-completed', onStepCompleted);
      win.removeEventListener('message', onMessage);
    },
  };
}
