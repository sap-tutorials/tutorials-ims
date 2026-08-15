// hugo-apps/src/alerts/__tests__/Alerts.cta.test.ts
//
// @vitest-environment happy-dom
//
// Issue #1805: the Call-to-Action button was slotted into "footnote"
// (singular). ui5-li-notification's footer slot is "footnotes" (plural,
// individualSlots) — an element assigned to a non-existent named slot is
// never rendered, so the CTA silently vanished from the notification popover.
// This guards the slot name and the click contract.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Alerts from '../Alerts.vue';
import type { ApiAlert } from '../types';

function alert(overrides: Partial<ApiAlert> = {}): ApiAlert {
  return {
    id: 'A1',
    title: 'The first week on the new Developer Center',
    body: 'Lots of new functionality shipped this week.',
    severity: 'Information',
    ctaLabel: "What's New",
    ctaUrl: '/whats-new/',
    dismissible: true,
    startsAt: '2026-08-01T00:00:00Z',
    endsAt: null,
    ...overrides,
  };
}

describe('Alerts CTA rendering (#1805)', () => {
  it('renders the CTA into the footnotes slot (not the invalid "footnote" slot)', () => {
    const wrapper = mount(Alerts, { props: { alerts: [alert()] } });
    const btn = wrapper.find('ui5-button');
    expect(btn.exists()).toBe(true);
    // The whole bug: slot MUST be the plural "footnotes" that the
    // NotificationListItem shadow DOM actually exposes.
    expect(btn.attributes('slot')).toBe('footnotes');
    expect(btn.text()).toBe("What's New");
  });

  it('emits cta with the url on click', async () => {
    const wrapper = mount(Alerts, { props: { alerts: [alert()] } });
    await wrapper.find('ui5-button').trigger('click');
    expect(wrapper.emitted('cta')?.[0]).toEqual(['/whats-new/']);
  });

  it('falls back to "Open" when no ctaLabel is set', () => {
    const wrapper = mount(Alerts, { props: { alerts: [alert({ ctaLabel: null })] } });
    expect(wrapper.find('ui5-button').text()).toBe('Open');
  });

  it('renders no CTA button when ctaUrl is absent', () => {
    const wrapper = mount(Alerts, { props: { alerts: [alert({ ctaUrl: null })] } });
    expect(wrapper.find('ui5-button').exists()).toBe(false);
  });
});
