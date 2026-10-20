// hugo-apps/src/tutorial-variables/__tests__/TutorialVariables.test.ts
//
// @vitest-environment happy-dom
//
// [#2852] Component behavior for hidden (display:false) + author-fixed (value)
// variables:
//  - an input is rendered only for displayed variables
//  - a hidden variable with a literal value still substitutes into the page
//  - the panel does not render when every variable is hidden
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import TutorialVariables from '../TutorialVariables.vue';
import type { TutorialVariable } from '../substitution';

function seedSpans(...names: string[]) {
  for (const n of names) {
    const span = document.createElement('span');
    span.className = 'tut-var';
    span.setAttribute('data-tut-var', n);
    document.body.appendChild(span);
  }
}

describe('TutorialVariables — hidden + fixed values [#2852]', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // Identity fetch fails → identity null; keeps defaults out of the way.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders an input only for displayed variables', async () => {
    const variables: TutorialVariable[] = [
      { name: 'groupNumber', label: 'Group', type: 'string' },
      { name: 'prod', type: 'string', value: 'MyApp 2.0', display: false },
    ];
    const wrapper = mount(TutorialVariables, {
      props: { variables, slug: 's', missionSlug: '' },
    });
    await flushPromises();
    const inputs = wrapper.findAll('input');
    expect(inputs).toHaveLength(1);
    expect(wrapper.find('input').attributes('id')).toBe('tv-input-groupNumber');
  });

  it('substitutes a hidden author-fixed value into the page', async () => {
    seedSpans('prod');
    const variables: TutorialVariable[] = [
      { name: 'prod', type: 'string', value: 'MyApp 2.0', display: false },
    ];
    mount(TutorialVariables, {
      props: { variables, slug: 's', missionSlug: '' },
    });
    await flushPromises();
    const span = document.querySelector('[data-tut-var="prod"]');
    expect(span?.textContent).toBe('MyApp 2.0');
  });

  it('does not render the panel when every variable is hidden', async () => {
    const variables: TutorialVariable[] = [
      { name: 'prod', type: 'string', value: 'MyApp 2.0', display: false },
    ];
    const wrapper = mount(TutorialVariables, {
      props: { variables, slug: 's', missionSlug: '' },
    });
    await flushPromises();
    expect(wrapper.find('section.tv').exists()).toBe(false);
  });

  it('pre-fills a displayed variable with its literal value yet keeps the input editable', async () => {
    seedSpans('prod');
    const variables: TutorialVariable[] = [
      { name: 'prod', label: 'Product', type: 'string', value: 'MyApp 2.0' },
    ];
    const wrapper = mount(TutorialVariables, {
      props: { variables, slug: 's', missionSlug: '' },
    });
    await flushPromises();
    const input = wrapper.find('input');
    // rendered (displayed) and pre-filled with the literal value
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe('MyApp 2.0');
    expect(document.querySelector('[data-tut-var="prod"]')?.textContent).toBe('MyApp 2.0');
    // still editable: typing overrides the literal value in the page
    await input.setValue('Other App');
    expect(document.querySelector('[data-tut-var="prod"]')?.textContent).toBe('Other App');
  });
});
