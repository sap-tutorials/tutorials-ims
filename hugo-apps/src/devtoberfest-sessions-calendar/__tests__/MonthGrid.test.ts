// hugo-apps/src/devtoberfest-sessions-calendar/__tests__/MonthGrid.test.ts
//
// @vitest-environment happy-dom
//
// Direct MonthGrid tests for issue #2046: dense month grid must show compact
// time+title chips (no full date / no speaker line) and expose an in-place
// per-day overflow popover for busy days instead of navigating away.
//
// TZ-pinning: set BEFORE any import so viewerDayKey / Intl resolve to UTC and
// the fixtures bucket onto the day we expect.
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MonthGrid from '../MonthGrid.vue';
import { groupByDate } from '../calendar-core';
import type { Session } from '../../devtoberfest-schedule-shared/types';

const SESSIONS: Session[] = [
  { id: 's1', kind: 'session', title: 'Alpha Talk', trackName: 'AI',
    scheduledStart: '2026-10-05T14:00:00Z',
    speakers: [{ id: 'sp1', name: 'Ada Lovelace' }] },
  { id: 's2', kind: 'session', title: 'Beta Talk', trackName: 'CAP',
    scheduledStart: '2026-10-05T15:00:00Z' },
  { id: 's3', kind: 'session', title: 'Gamma Talk', trackName: 'CAP',
    scheduledStart: '2026-10-05T16:00:00Z' },
  { id: 's4', kind: 'session', title: 'Delta Talk', trackName: 'AI',
    scheduledStart: '2026-10-05T17:00:00Z' },
];

function mountGrid(maxChips = 2) {
  return mount(MonthGrid, {
    props: {
      cursor: new Date(Date.UTC(2026, 9, 1)), // October 2026
      byDate: groupByDate(SESSIONS),
      colors: new Map(),
      today: '2026-10-01',
      isAuthenticated: false,
      maxChips,
    },
  });
}

describe('MonthGrid compact chips + overflow popover (#2046)', () => {
  it('renders a 6×7 = 42-cell month grid', () => {
    const wrapper = mountGrid();
    expect(wrapper.findAll('.mg-cell')).toHaveLength(42);
  });

  it('chips show compact viewer-local time (no full date), not speaker names', () => {
    const wrapper = mountGrid();
    const chip = wrapper.findAll('.mg-chip').find((c) => c.text().includes('Alpha Talk'))!;
    expect(chip).toBeTruthy();
    // time-only: h:mm AM present, no "Oct"/"2026" date, no timezone token
    expect(chip.find('.mg-chip-t').text()).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(chip.text()).not.toMatch(/Oct|2026|UTC|GMT/);
    // speakers moved to the tooltip, not the visible chip
    expect(chip.text()).not.toContain('Ada Lovelace');
    expect(chip.attributes('title')).toContain('Ada Lovelace');
  });

  it('caps visible chips at maxChips and shows a "+N more" button', () => {
    const wrapper = mountGrid(2);
    // Oct 5 has 4 sessions, maxChips=2 → 2 visible chips + "+2 more"
    expect(wrapper.html()).toContain('+2 more');
  });

  it('"+N more" opens an in-place popover listing ALL that day\'s sessions', async () => {
    const wrapper = mountGrid(2);
    expect(wrapper.find('.mg-pop').exists()).toBe(false);
    await wrapper.get('.mg-more').trigger('click');
    const pop = wrapper.find('.mg-pop');
    expect(pop.exists()).toBe(true);
    expect(pop.attributes('role')).toBe('dialog');
    // all four sessions listed, including the two that were overflowed
    const text = pop.text();
    expect(text).toContain('Alpha Talk');
    expect(text).toContain('Beta Talk');
    expect(text).toContain('Gamma Talk');
    expect(text).toContain('Delta Talk');
  });

  it('clicking a popover session emits select and closes the popover', async () => {
    const wrapper = mountGrid(2);
    await wrapper.get('.mg-more').trigger('click');
    const popChip = wrapper.findAll('.mg-pop-chip').find((c) => c.text().includes('Delta Talk'))!;
    await popChip.trigger('click');
    expect(wrapper.emitted('select')).toBeTruthy();
    expect((wrapper.emitted('select')![0][0] as Session).id).toBe('s4');
    expect(wrapper.find('.mg-pop').exists()).toBe(false);
  });

  it('backdrop click closes the popover', async () => {
    const wrapper = mountGrid(2);
    await wrapper.get('.mg-more').trigger('click');
    expect(wrapper.find('.mg-backdrop').exists()).toBe(true);
    await wrapper.get('.mg-backdrop').trigger('click');
    expect(wrapper.find('.mg-pop').exists()).toBe(false);
  });

  it('the day-number button still emits openDay (full Day view navigation)', async () => {
    const wrapper = mountGrid(2);
    await wrapper.get('.mg-daynum').trigger('click');
    expect(wrapper.emitted('openDay')).toBeTruthy();
  });
});
