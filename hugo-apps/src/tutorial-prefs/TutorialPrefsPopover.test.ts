// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TutorialPrefsPopover from './TutorialPrefsPopover.vue';

const stubs = {
  'ui5-popover': { template: '<div><slot/></div>' },
  'ui5-switch': { template: '<span/>' },
  'ui5-button': { template: '<button @click="$emit(\'click\')"><slot/></button>' }
};
const base = {
  readerOn: false, onTutorialPage: true, supported: true, unsupportedReasonText: '',
  eyePref: 'on', handPref: 'off', eyeRunning: false, handRunning: false,
  eyeFirstRun: false, handFirstRun: false, eyeError: '', handError: '',
  eyeCalibrated: false, handCalibrated: false
};

describe('TutorialPrefsPopover calibration control', () => {
  it('shows a Calibrate button when the eye toggle is on', () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    expect(w.text()).toContain('Calibrate');
  });

  it('shows "Not calibrated" hint when no eye profile exists', () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    expect(w.text()).toContain('Not calibrated');
  });

  it('shows "Calibrated" hint when an eye profile exists', () => {
    const w = mount(TutorialPrefsPopover, { props: { ...base, eyeCalibrated: true }, global: { stubs } });
    expect(w.text()).toContain('Calibrated');
  });

  it('emits calibrate("eye") when the Calibrate button is clicked', async () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    const btn = w.findAll('button').find((b) => b.text() === 'Calibrate')!;
    await btn.trigger('click');
    expect(w.emitted('calibrate')![0]).toEqual(['eye']);
  });
});

// Dispatch a UI5-shaped selection-change carrying the picked item's dataset.
function fireSelect(el: Element, dataset: Record<string, string>) {
  el.dispatchEvent(new CustomEvent('selection-change', {
    detail: { selectedItems: [{ dataset }] }
  }));
}

describe('TutorialPrefsPopover size/width mount-fire guard', () => {
  const cases: Array<{ name: string; testid: string; prop: string; key: string; same: string; other: string; event: string }> = [
    { name: 'text size', testid: 'tut-prefs-text-size', prop: 'textSize', key: 'size', same: 'm', other: 'l', event: 'set-text-size' },
    { name: 'code size', testid: 'tut-prefs-code-size', prop: 'codeSize', key: 'size', same: 's', other: 'l', event: 'set-code-size' },
    { name: 'screenshot size', testid: 'tut-prefs-img-size', prop: 'imgSize', key: 'size', same: 'l', other: 's', event: 'set-img-size' },
    { name: 'reading width', testid: 'tut-prefs-read-width', prop: 'readWidth', key: 'width', same: 'narrow', other: 'wide', event: 'set-read-width' }
  ];

  for (const c of cases) {
    it(`does not emit ${c.event} when ${c.name} matches the current pref`, () => {
      const w = mount(TutorialPrefsPopover, { props: { ...base, [c.prop]: c.same }, global: { stubs } });
      fireSelect(w.get(`[data-testid="${c.testid}"]`).element, { [c.key]: c.same });
      expect(w.emitted(c.event)).toBeUndefined();
    });

    it(`emits ${c.event} when ${c.name} changes`, () => {
      const w = mount(TutorialPrefsPopover, { props: { ...base, [c.prop]: c.same }, global: { stubs } });
      fireSelect(w.get(`[data-testid="${c.testid}"]`).element, { [c.key]: c.other });
      expect(w.emitted(c.event)![0]).toEqual([c.other]);
    });
  }
});
