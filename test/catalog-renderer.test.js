// test/catalog-renderer.test.js
import { describe, it, expect } from 'vitest';
import { renderGroupBody, renderMissionBody } from '../srv/lib/catalog-renderer.js';

const TODAY = new Date('2026-05-28T00:00:00Z');
const recent = new Date(TODAY); recent.setDate(recent.getDate() - 5);
const old = new Date(TODAY); old.setDate(old.getDate() - 60);

const fxGroup = {
  group: { ID: 'g1', slug: 'foo', title: 'Foo Group', description: 'Foo desc' },
  tutorials: [
    { slug: 't1', title: 'T1', description: 'd1', level: 'beginner', time: 10,
      stepCount: 3, primaryTag: 'CAP', createdAt: recent.toISOString() },
    { slug: 't2', title: 'T2', description: 'd2', level: 'advanced', time: 30,
      stepCount: 5, primaryTag: 'HANA', createdAt: old.toISOString() },
  ],
  tutorialCount: 2,
  totalTime: 40,
  level: 'advanced',
};

describe('renderGroupBody', () => {
  it('renders the wrapper, hero, and timeline classes', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('class="group-wrapper"');
    expect(html).toContain('class="group-hero"');
    expect(html).toContain('class="tutorial-timeline"');
    expect(html).toContain('class="type-badge type-badge--group">GROUP');
    expect(html).toContain('class="timeline-item"');
    expect(html).toContain('class="timeline-card');
    expect(html).toContain('class="start-btn"');
  });

  it('emits group-meta with level, totalTime, and tutorialCount', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('Advanced');
    expect(html).toContain('40 min.');
    expect(html).toContain('2 Tutorials');
  });

  it('marks recent tutorials with timeline-card--new + NEW badge', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    const t1Idx = html.indexOf('href="/tutorials/t1"');
    const t2Idx = html.indexOf('href="/tutorials/t2"');
    const newBadgeIdx = html.indexOf('NEW</span>');
    expect(newBadgeIdx).toBeGreaterThan(0);
    // Hugo parity: hugo/layouts/groups/single.html places the NEW badge BEFORE
    // <div class="timeline-card-header"> (which contains the <a href>). So in
    // source order the badge appears before t1's link but still inside t1's
    // timeline-card — i.e. before t2's link.
    expect(newBadgeIdx).toBeLessThan(t1Idx);
    expect(newBadgeIdx).toBeLessThan(t2Idx);
    expect(html).toContain('timeline-card--new');
  });

  it('escapes HTML in titles and descriptions', () => {
    const evil = {
      ...fxGroup,
      group: { ...fxGroup.group, title: '<script>alert(1)</script>' },
    };
    const html = renderGroupBody(evil, { now: TODAY });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty timeline when tutorials list is empty', () => {
    const empty = { ...fxGroup, tutorials: [], tutorialCount: 0, totalTime: 0 };
    const html = renderGroupBody(empty, { now: TODAY });
    expect(html).toContain('class="tutorial-timeline"');
    expect(html).toContain('0 Tutorials');
  });

  it('emits primary-tag chip on each card', () => {
    const html = renderGroupBody(fxGroup, { now: TODAY });
    expect(html).toContain('class="timeline-card-tag">CAP');
    expect(html).toContain('class="timeline-card-tag">HANA');
  });
});

const fxMission = {
  mission: { ID: 'm1', slug: 'bar', title: 'Bar Mission', description: 'Bar desc' },
  groups: [
    { ID: 'g1', slug: 'g-one', title: 'G One',
      tutorials: [{ slug: 't1', title: 'T1', level: 'beginner', time: 5, stepCount: 1 }] },
    { ID: 'g2', slug: 'g-two', title: 'G Two',
      tutorials: [{ slug: 't2', title: 'T2', level: 'intermediate', time: 12, stepCount: 4 }] },
  ],
  groupCount: 2,
  tutorialCount: 2,
  totalTime: 17,
  level: 'intermediate',
};

describe('renderMissionBody', () => {
  it('renders mission wrapper, hero, and group-card list', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('class="mission-wrapper"');
    expect(html).toContain('class="mission-hero"');
    expect(html).toContain('class="groups-section"');
    expect(html).toContain('class="group-card"');
    expect(html).toContain('class="type-badge type-badge--mission">MISSION');
  });

  it('links each group card to /tutorials/group-<slug>', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('href="/tutorials/group-g-one"');
    expect(html).toContain('href="/tutorials/group-g-two"');
  });

  it('emits the group-card-header onclick + first-card-expand inline behaviors', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain("this.parentElement.classList.toggle('expanded')");
    // Parity with hugo/layouts/missions/single.html: safe two-line form
    // (var firstCard = ...; if (firstCard) firstCard.classList.add('expanded'))
    expect(html).toContain("document.querySelector('.group-card')");
    expect(html).toContain("classList.add('expanded')");
  });

  it('emits inner tutorial list with /tutorials/<slug> links', () => {
    const html = renderMissionBody(fxMission);
    expect(html).toContain('class="tutorial-item"');
    expect(html).toContain('href="/tutorials/t1"');
    expect(html).toContain('href="/tutorials/t2"');
  });
});
