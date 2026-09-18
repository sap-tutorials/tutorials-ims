// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h } from 'vue';
import DetailPanel from '../DetailPanel.vue';

/**
 * DetailPanel is a MODAL slide-over drawer, not a docked master-detail pane.
 * When no row is selected it must render nothing — a leftover empty-state
 * placeholder rendered a UI5 IllustratedMessage whose default title is
 * "There's no data yet." inline at the bottom of pages that clearly had data.
 * See devtoberfest schedule/sessions/calendar pages.
 */
function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(DetailPanel as any, props) });
  app.mount(host);
  return { host, app };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('DetailPanel empty state', () => {
  it('renders nothing when no row is selected', () => {
    const { host } = mount({ row: null });
    expect(host.querySelector('.detail-panel')).toBeNull();
    expect(host.querySelector('.detail-panel--empty')).toBeNull();
    expect(host.querySelector('ui5-illustrated-message')).toBeNull();
    expect(host.textContent).not.toContain('Select an activity');
  });

  it('renders the drawer when a row is selected', () => {
    const { host } = mount({ row: { id: 's1', kind: 'session', title: 'My Session' } });
    expect(host.querySelector('.detail-panel__drawer')).not.toBeNull();
    expect(host.querySelector('.detail-panel__title')?.textContent).toContain('My Session');
    // the empty-state placeholder must never coexist with a selected row
    expect(host.querySelector('.detail-panel--empty')).toBeNull();
  });
});

// --- TechEd enriched speaker rendering (items 3, 9, 10) ----------------------

describe('DetailPanel enriched speakers (TechEd)', () => {
  function rowWithSpeakers(speakers: unknown[]) {
    return {
      row: {
        title: 'Test Session',
        speakersEnriched: speakers,
      },
      source: 'teched',
    };
  }

  it('item 3: enriched speaker with authorLogin renders as an anchor linking to /authors/{login}/', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp1', name: 'Ada Lovelace', authorLogin: 'ada-lovelace' },
    ]));
    const link = host.querySelector('a.detail-panel__speaker-link');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/authors/ada-lovelace/');
    expect(link?.textContent).toContain('Ada Lovelace');
  });

  it('#2392: advocateSlug is preferred over authorLogin → links to /developer-advocates/{slug}/', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp3', name: 'DJ Adams', authorLogin: 'qmacro', advocateSlug: 'dj-adams' },
    ]));
    const link = host.querySelector('a.detail-panel__speaker-link');
    expect(link?.getAttribute('href')).toBe('/developer-advocates/dj-adams/');
  });

  it('#2392: advocate without an author login still links to the advocate page', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp4', name: 'Rekha D R', advocateSlug: 'rekha-d-r' },
    ]));
    const link = host.querySelector('a.detail-panel__speaker-link');
    expect(link?.getAttribute('href')).toBe('/developer-advocates/rekha-d-r/');
  });

  it('item 3: enriched speaker without authorLogin renders as a plain span, no anchor', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp2', name: 'Grace Hopper' },
    ]));
    // No anchor with authors href
    expect(host.querySelector('a[href*="/authors/"]')).toBeNull();
    // Name still visible in the speaker-name element
    const name = host.querySelector('.detail-panel__speaker-name');
    expect(name?.textContent).toContain('Grace Hopper');
    expect(name?.tagName.toLowerCase()).toBe('span');
  });

  it('item 10: bio present → speaker-name element has a title containing plain-text bio (markdown stripped)', () => {
    const { host } = mount(rowWithSpeakers([
      {
        id: 'sp3', name: 'Alan Turing',
        bio: 'Pioneer of **computing** and [AI research](https://example.com). ![photo](img.png)',
      },
    ]));
    const name = host.querySelector('.detail-panel__speaker-name');
    const title = name?.getAttribute('title') ?? '';
    expect(title).toBeTruthy();
    // Markdown removed: no **, no [text](url), no ![alt](url)
    expect(title).not.toContain('**');
    expect(title).not.toContain('[AI research]');
    expect(title).not.toContain('![photo]');
    // Plain text content preserved
    expect(title).toContain('Pioneer of');
    expect(title).toContain('computing');
  });

  it('item 10: bio null → no title attribute on speaker-name element', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp4', name: 'Linus Torvalds', bio: null },
    ]));
    const name = host.querySelector('.detail-panel__speaker-name');
    // title should be absent or empty
    expect(name?.getAttribute('title') || '').toBe('');
  });

  it('item 10: bio undefined → no title attribute on speaker-name element', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp5', name: 'Margaret Hamilton' },
    ]));
    const name = host.querySelector('.detail-panel__speaker-name');
    expect(name?.getAttribute('title') || '').toBe('');
  });

  it('item 10: long bio (>300 chars) → title length ≤ 301 and ends with ellipsis', () => {
    const longBio = 'A'.repeat(350);
    const { host } = mount(rowWithSpeakers([
      { id: 'sp6', name: 'Barbara Liskov', bio: longBio },
    ]));
    const name = host.querySelector('.detail-panel__speaker-name');
    const title = name?.getAttribute('title') ?? '';
    expect(title.length).toBeLessThanOrEqual(301);
    expect(title.endsWith('…')).toBe(true);
  });

  it('item 9: photoUrl present → img rendered with matching src and alt', () => {
    const { host } = mount(rowWithSpeakers([
      { id: 'sp7', name: 'Radia Perlman', photoUrl: 'https://example.com/radia.jpg' },
    ]));
    const img = host.querySelector('.detail-panel__speaker-photo') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/radia.jpg');
    expect(img?.getAttribute('alt')).toBe('Radia Perlman');
  });
});
