// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h } from 'vue';
import DetailPanel from '../DetailPanel.vue';

/**
 * DetailPanel is a MODAL slide-over drawer, not a docked master-detail pane.
 * When no row is selected it must render nothing — a leftover empty-state
 * placeholder rendered a UI5 IllustratedMessage whose default title is
 * "There's no data yet." inline at the bottom of pages that clearly had data.
 * See devtoberfest schedule/sessions/calendar pages.
 */
function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DetailPanel as any, props) });
  app.mount(host);
  return { host, app };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('DetailPanel empty state', () => {
  it('renders nothing when no row is selected', () => {
    const { host } = mount({ row: null });
    expect(host.querySelector('.detail-panel')).toBeNull();
    expect(host.querySelector('.detail-panel--empty')).toBeNull();
    expect(host.querySelector('ui5-illustrated-message')).toBeNull();
    expect(host.textContent).not.toContain('Select an activity');
  });

  it('renders the drawer when a row is selected', () => {
    const { host } = mount({ row: { id: 's1', kind: 'session', title: 'My Session' } });
    expect(host.querySelector('.detail-panel__drawer')).not.toBeNull();
    expect(host.querySelector('.detail-panel__title')?.textContent).toContain('My Session');
    // the empty-state placeholder must never coexist with a selected row
    expect(host.querySelector('.detail-panel--empty')).toBeNull();
  });
});
