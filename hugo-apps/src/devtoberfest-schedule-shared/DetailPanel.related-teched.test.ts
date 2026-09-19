// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DetailPanel from './DetailPanel.vue';

const baseRow = { id: 's1', kind: 'session', title: 'Test Session' };

describe('DetailPanel related TechEd sessions block', () => {
  it('renders links to /teched/?session=<slug> when relatedTechEdSessions is present', () => {
    const row = {
      ...baseRow,
      relatedTechEdSessions: [
        { slug: 's1', title: 'T1', sessionCode: 'TE100', venue: 'BERLIN' },
        { slug: 's2', title: 'T2', sessionCode: 'TE200' },
      ],
    };
    const w = mount(DetailPanel, { props: { row } });
    const links = w.findAll('a.detail-panel__link--teched');
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/teched/?session=s1');
    expect(links[0].text()).toContain('T1');
    expect(links[0].text()).toContain('TE100');
    expect(links[0].text()).toContain('BERLIN');
    expect(links[1].attributes('href')).toBe('/teched/?session=s2');
    expect(links[1].text()).toContain('T2');
    expect(links[1].text()).toContain('TE200');
  });

  it('shows the section heading when relatedTechEdSessions is present', () => {
    const row = {
      ...baseRow,
      relatedTechEdSessions: [{ slug: 'x1', title: 'X Session' }],
    };
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__related-teched-label').exists()).toBe(true);
    expect(w.find('.detail-panel__related-teched-label').text()).toMatch(/related sap teched sessions/i);
  });

  it('does not render the related TechEd block when relatedTechEdSessions is absent', () => {
    const w = mount(DetailPanel, { props: { row: baseRow } });
    expect(w.find('.detail-panel__related-teched').exists()).toBe(false);
  });

  it('does not render the related TechEd block when relatedTechEdSessions is empty', () => {
    const row = { ...baseRow, relatedTechEdSessions: [] };
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.detail-panel__related-teched').exists()).toBe(false);
  });

  it('URL-encodes slugs that contain special characters', () => {
    const row = {
      ...baseRow,
      relatedTechEdSessions: [{ slug: 'session/with spaces', title: 'Encoded' }],
    };
    const w = mount(DetailPanel, { props: { row } });
    const link = w.find('a.detail-panel__link--teched');
    expect(link.attributes('href')).toBe('/teched/?session=session%2Fwith%20spaces');
  });
});

// Reverse direction (#2312 follow-up): a TechEd row carries
// relatedDevtoberfestSessions; the panel renders the same RelatedSessions block
// shown on /teched/ grid cards. A TechEd row has no `kind` and the grid passes
// source="teched".
const techedRow = { slug: 'ad903', title: 'Build agents', sessionCode: 'AD903' };

describe('DetailPanel related Devtoberfest sessions block (teched rows)', () => {
  it('renders the RelatedSessions block for a teched row with relatedDevtoberfestSessions', () => {
    const row = {
      ...techedRow,
      relatedDevtoberfestSessions: [
        { sessionId: 'dtf-1', title: 'DTF One', sessionCode: 'AI-12' },
        { sessionId: 'dtf-2', title: 'DTF Two', sessionCode: 'DAT-31' },
      ],
    };
    const w = mount(DetailPanel, { props: { row, source: 'teched' } });
    expect(w.find('.tsg-related').exists()).toBe(true);
    expect(w.find('.tsg-related-heading').text()).toMatch(/related devtoberfest sessions/i);
    const links = w.findAll('a.tsg-related-link');
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/devtoberfest/sessions/?session=dtf-1');
    expect(links[0].text()).toContain('DTF One');
    expect(links[0].text()).toContain('AI-12');
  });

  it('does not render the block when relatedDevtoberfestSessions is absent', () => {
    const w = mount(DetailPanel, { props: { row: techedRow, source: 'teched' } });
    expect(w.find('.tsg-related').exists()).toBe(false);
  });

  it('does not render the block for a Devtoberfest row even if the field is present', () => {
    // A DTF row (source defaults to 'devtoberfest', has kind:'session') must not
    // show the reverse block — the isTeched guard keeps it teched-only.
    const row = {
      ...baseRow,
      relatedDevtoberfestSessions: [{ sessionId: 'x', title: 'X', sessionCode: 'Y-1' }],
    };
    const w = mount(DetailPanel, { props: { row } });
    expect(w.find('.tsg-related').exists()).toBe(false);
  });
});

