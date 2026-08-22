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
