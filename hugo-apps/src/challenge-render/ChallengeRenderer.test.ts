// hugo-apps/src/challenge-render/ChallengeRenderer.test.ts
//
// @vitest-environment happy-dom
//
// RESEARCH SPIKE (#2362) — proves the json-render renderer: a spec of catalog
// nodes maps to real components, and an unknown node type is dropped (never
// rendered), which is the core json-render safety guarantee.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChallengeRenderer from './ChallengeRenderer.vue';

describe('ChallengeRenderer', () => {
  it('renders each catalog node type', () => {
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: {
          nodes: [
            { id: 'c-1', type: 'heading', text: 'Check yourself' },
            { id: 'c-2', type: 'prose', text: 'A scenario.' },
            { id: 'c-3', type: 'mcq', prompt: 'Which file?', options: ['a.cds', 'b', 'c', 'd'], answerIndex: 0 },
            { id: 'c-4', type: 'freeText', prompt: 'Explain.', aiGraded: true },
          ],
        },
      },
    });
    expect(wrapper.find('h3.challenge-heading').text()).toBe('Check yourself');
    expect(wrapper.find('p.challenge-prose').text()).toBe('A scenario.');
    expect(wrapper.findAll('.challenge-option')).toHaveLength(4);
    expect(wrapper.find('.challenge-freetext textarea').exists()).toBe(true);
    expect(wrapper.find('.challenge-ai-note').exists()).toBe(true);
  });

  it('drops an unknown node type instead of rendering it', () => {
    const wrapper = mount(ChallengeRenderer, {
      props: { spec: { nodes: [{ id: 'x', type: 'iframe', text: 'nope' }] } },
    });
    // Unknown type produces no output — the panel does not render at all.
    expect(wrapper.find('.challenge-panel').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('nope');
  });

  it('renders nothing for a null spec', () => {
    const wrapper = mount(ChallengeRenderer, { props: { spec: null } });
    expect(wrapper.find('.challenge-panel').exists()).toBe(false);
  });
});
