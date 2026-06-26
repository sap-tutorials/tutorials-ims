// hugo-apps/src/alerts/main.ts
//
// Bell-mounted alert island. Boots after the shellbar is defined,
// fetches the right endpoint, dismisses via localStorage, wires the
// shellbar notifications-click.
//
// Spec: docs/superpowers/specs/2026-06-26-548-alert-system-design.md

// UI5 components (Popover, List, Button, IllustratedMessage, NotificationListItem,
// NoNotifications illustration) are registered globally by hugo/assets/js/ui5-bootstrap.ts.
// Do NOT re-import them here — that would balloon the bundle (alerts.js budget is 12 KB gz).

import { createApp, ref, reactive, computed } from 'vue';
import Alerts from './Alerts.vue';
import { fetchAlerts } from './api';
import { filterVisible, readDismissedSet, dismiss } from './dismiss-filter';
import type { ApiAlert } from './types';

const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function boot() {
  // Wait for shellbar to be defined.
  await customElements.whenDefined('ui5-shellbar');
  const shellbar = document.getElementById('app-shellbar');
  const popover  = document.getElementById('sb-alerts-popover');
  const slot     = document.getElementById('sb-alerts-mount');
  if (!shellbar || !popover || !slot) return;

  const alerts = ref<ApiAlert[]>([]);
  const dismissed = reactive(readDismissedSet());
  const visible = computed(() => filterVisible(alerts.value, dismissed));

  // Mount the Vue island into the popover.
  const app = createApp({
    components: { Alerts },
    setup() {
      return { visible };
    },
    template: `<Alerts :alerts="visible" @dismiss="onDismiss" @cta="onCta" />`,
    methods: {
      onDismiss(id: string) {
        dismiss(id);
        dismissed.add(id);
        updateBadge();
      },
      onCta(url: string) {
        if (url.startsWith('/')) window.location.href = url;
        else window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
  });
  app.mount(slot);

  function updateBadge() {
    shellbar!.setAttribute('notifications-count', visible.value.length === 0 ? '' : String(visible.value.length));
  }

  async function load() {
    const authenticated = document.documentElement.dataset.authenticated === 'true';
    const res = await fetchAlerts(authenticated);
    alerts.value = res.alerts;
    updateBadge();
  }

  // Wait for auth-resolved before first fetch.
  await new Promise<void>(resolve => {
    if (document.documentElement.dataset.authenticated !== undefined) {
      resolve(); return;
    }
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    document.addEventListener('auth-resolved', done, { once: true });
    setTimeout(done, 200); // fallback if /auth/user 5xxs
  });
  await load();

  // Wire bell click.
  shellbar.addEventListener('notifications-click', (e: any) => {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    (popover as any).opener = e.detail?.targetRef || shellbar;
    (popover as any).open = !(popover as any).open;
  });

  // Periodic refresh while visible.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    load();
  }, POLL_INTERVAL_MS);
}

boot();
