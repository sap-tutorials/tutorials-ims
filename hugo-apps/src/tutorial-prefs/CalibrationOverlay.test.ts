// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CalibrationOverlay from './CalibrationOverlay.vue';

const stubs = { 'ui5-button': { template: '<button @click="$emit(\'click\')"><slot/></button>' } };

describe('CalibrationOverlay', () => {
  it('intro phase shows instructions and a Begin button, emits start', async () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'eye', phase: 'intro', progress: 0 }, global: { stubs } });
    expect(w.text()).toContain('scan');           // eye instruction mentions scanning the page
    await w.find('button').trigger('click');
    expect(w.emitted('start')).toBeTruthy();
  });

  it('capturing phase reflects progress width', () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'eye', phase: 'capturing', progress: 0.5 }, global: { stubs } });
    const bar = w.find('.cal-overlay__bar-fill');
    expect(bar.attributes('style') ?? '').toContain('50%');
  });

  it('invalid phase shows retry + cancel and emits them', async () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'hand', phase: 'invalid', progress: 0 }, global: { stubs } });
    expect(w.text()).toContain('try again');
    const buttons = w.findAll('button');
    await buttons[0].trigger('click');            // Retry
    await buttons[1].trigger('click');            // Cancel
    expect(w.emitted('retry')).toBeTruthy();
    expect(w.emitted('cancel')).toBeTruthy();
  });

  it('hand intro mentions sweeping', () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'hand', phase: 'intro', progress: 0 }, global: { stubs } });
    expect(w.text().toLowerCase()).toContain('sweep');
  });
});
