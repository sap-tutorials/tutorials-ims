// hugo-apps/src/challenge-render/ChallengeRenderer.test.ts
//
// @vitest-environment happy-dom
//
// RESEARCH SPIKE (#2362) — proves the json-render renderer: a spec of catalog
// nodes maps to real components, and an unknown node type is dropped (never
// rendered), which is the core json-render safety guarantee.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChallengeRenderer from './ChallengeRenderer.vue';

// Mock the shared CSRF fetch so freeText grading tests never hit the network.
const csrfFetch = vi.fn();
vi.mock('@shared/csrf-fetch', () => ({ csrfFetch: (...args: unknown[]) => csrfFetch(...args) }));

beforeEach(() => { csrfFetch.mockReset(); });

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

  // ── Grading (#2441) ─────────────────────────────────────────────────────

  it('mcq: correct selection → correct verdict, no server call', async () => {
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: { nodes: [{ id: 'c-3', type: 'mcq', prompt: 'Which?', options: ['a', 'b'], answerIndex: 1 }] },
      },
    });
    await wrapper.findAll('.challenge-option input')[1].setValue();
    await wrapper.find('.challenge-mcq .challenge-check').trigger('click');
    const verdict = wrapper.find('.challenge-verdict');
    expect(verdict.attributes('data-status')).toBe('correct');
    expect(csrfFetch).not.toHaveBeenCalled();
  });

  it('mcq: wrong selection → incorrect verdict', async () => {
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: { nodes: [{ id: 'c-3', type: 'mcq', prompt: 'Which?', options: ['a', 'b'], answerIndex: 1 }] },
      },
    });
    await wrapper.findAll('.challenge-option input')[0].setValue();
    await wrapper.find('.challenge-mcq .challenge-check').trigger('click');
    expect(wrapper.find('.challenge-verdict').attributes('data-status')).toBe('incorrect');
  });

  it('freeText: POSTs to /api/challenge-grade and renders a pass verdict', async () => {
    csrfFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ verdict: 'pass', summary: 'Well done' }) });
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: { nodes: [{ id: 'challenge-2-0', type: 'freeText', prompt: 'Explain.', aiGraded: true }] },
        slug: 'my-tutorial',
        stepNumber: 2,
      },
    });
    await wrapper.find('.challenge-freetext textarea').setValue('my answer');
    await wrapper.find('.challenge-freetext .challenge-check').trigger('click');
    await new Promise((r) => setTimeout(r, 0)); // flush the awaited fetch
    await wrapper.vm.$nextTick();

    expect(csrfFetch).toHaveBeenCalledOnce();
    const [url, init] = csrfFetch.mock.calls[0];
    expect(url).toBe('/api/challenge-grade');
    expect(JSON.parse(init.body)).toEqual({
      tutorialSlug: 'my-tutorial', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'my answer',
    });
    const verdict = wrapper.find('.challenge-verdict');
    expect(verdict.attributes('data-status')).toBe('correct');
    expect(verdict.text()).toBe('Well done');
  });

  it('freeText: 503 → unavailable message, no crash', async () => {
    csrfFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: { nodes: [{ id: 'challenge-2-0', type: 'freeText', prompt: 'Explain.', aiGraded: true }] },
        slug: 'my-tutorial', stepNumber: 2,
      },
    });
    await wrapper.find('.challenge-freetext textarea').setValue('x');
    await wrapper.find('.challenge-freetext .challenge-check').trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.challenge-verdict').attributes('data-status')).toBe('error');
  });

  it('freeText: isPreview never POSTs', async () => {
    const wrapper = mount(ChallengeRenderer, {
      props: {
        spec: { nodes: [{ id: 'challenge-2-0', type: 'freeText', prompt: 'Explain.', aiGraded: true }] },
        slug: 'my-tutorial', stepNumber: 2, isPreview: true,
      },
    });
    await wrapper.find('.challenge-freetext textarea').setValue('x');
    await wrapper.find('.challenge-freetext .challenge-check').trigger('click');
    await wrapper.vm.$nextTick();
    expect(csrfFetch).not.toHaveBeenCalled();
  });
});
