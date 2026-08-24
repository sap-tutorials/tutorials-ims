// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

// Minimal markdown-it + DOMPurify stand-ins, mirroring the shared
// render-markdown test harness. Installed on window so renderMarkdown()
// produces real HTML instead of its escaped-plain-text fallback.
function installGlobals() {
  (globalThis as any).window.markdownit = () => ({
    render: (src: string) =>
      src
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.*)$/gm, '<ul><li>$1</li></ul>')
        .split(/\n{2,}/)
        .map((p) => (/^<ul>/.test(p) ? p : `<p>${p}</p>`))
        .join('\n'),
  });
  (globalThis as any).window.DOMPurify = {
    sanitize: (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ''),
  };
}

const baseRow = { id: 's1', kind: 'session', title: 'Test Session' };

describe('DetailPanel abstract markdown', () => {
  beforeEach(() => installGlobals());
  afterEach(() => {
    delete (globalThis as any).window.markdownit;
    delete (globalThis as any).window.DOMPurify;
  });

  it('renders markdown in the abstract as HTML (bold, lists, paragraphs)', () => {
    const row = {
      ...baseRow,
      abstract: 'First para with **bold**.\n\n- item one\n- item two',
    };
    const w = mount(DetailPanel, { props: { row } });
    const el = w.find('.detail-panel__abstract');
    expect(el.exists()).toBe(true);
    expect(el.html()).toContain('<strong>bold</strong>');
    expect(el.find('ul').exists()).toBe(true);
    // Raw markdown syntax must NOT leak into the rendered text.
    expect(el.html()).not.toContain('**bold**');
  });

  it('sanitizes dangerous markup in the abstract', () => {
    const row = { ...baseRow, abstract: 'safe<script>alert(1)</script>' };
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__abstract').html()).not.toContain('<script>');
  });

  it('omits the abstract block entirely when abstract is empty', () => {
    const w = mount(DetailPanel, { props: { row: { ...baseRow } } });
    expect(w.find('.detail-panel__abstract').exists()).toBe(false);
  });
});
