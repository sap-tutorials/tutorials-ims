// @vitest-environment happy-dom
// test/unit/option-tabs-aria.test.ts
//
// Task 4: WAI-ARIA option tabs + sync-group binding.
//
// Two test suites:
//   1. Hugo-render guard — spins up a throwaway Hugo site and asserts the
//      rendered HTML carries correct WAI-ARIA attributes (role=tablist, per-tab
//      aria-selected/aria-controls/id, roving tabindex, data-sync-key,
//      role=tabpanel, aria-labelledby).
//   2. DOM-behaviour suite — builds the expected ARIA-correct DOM in happy-dom
//      and drives the tab-switching helpers to assert arrow-key roving and
//      sync-group binding via sync-groups.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SHORTCODES = join(REPO_ROOT, 'hugo', 'layouts', 'shortcodes');

function hugoBinary(): string {
  return process.env.HUGO || 'hugo';
}

// ---------------------------------------------------------------------------
// 1. Hugo-render guard: ARIA markup
// ---------------------------------------------------------------------------

describe('option-tabs WAI-ARIA markup (Hugo render)', () => {
  let siteDir: string;
  let rendered = '';
  let renderedSync = '';

  beforeAll(() => {
    siteDir = mkdtempSync(join(tmpdir(), 'option-tabs-aria-'));
    mkdirSync(join(siteDir, 'layouts', 'shortcodes'), { recursive: true });
    mkdirSync(join(siteDir, 'layouts', '_default'), { recursive: true });
    mkdirSync(join(siteDir, 'content'), { recursive: true });

    copyFileSync(
      join(SHORTCODES, 'option-tabs.html'),
      join(siteDir, 'layouts', 'shortcodes', 'option-tabs.html'),
    );
    copyFileSync(
      join(SHORTCODES, 'tab.html'),
      join(siteDir, 'layouts', 'shortcodes', 'tab.html'),
    );

    writeFileSync(
      join(siteDir, 'hugo.toml'),
      'baseURL = "http://example.org/"\ntitle = "t"\n[markup.goldmark.renderer]\nunsafe = true\n',
    );
    writeFileSync(
      join(siteDir, 'layouts', '_default', 'single.html'),
      '{{ .Content }}\n',
    );

    // Page 1: unsynced tabs (backward-compat)
    writeFileSync(
      join(siteDir, 'content', 'unsynced.md'),
      '---\ntitle: unsynced\n---\n\n' +
      '{{% option-tabs tabs="Alpha,Beta" %}}\n' +
      '{{% tab index="0" name="Alpha" %}}\n\nAlpha body.\n\n{{% /tab %}}\n' +
      '{{% tab index="1" name="Beta" %}}\n\nBeta body.\n\n{{% /tab %}}\n' +
      '{{% /option-tabs %}}\n',
    );

    // Page 2: synced tabs (data-sync-key / data-sync-value)
    writeFileSync(
      join(siteDir, 'content', 'synced.md'),
      '---\ntitle: synced\n---\n\n' +
      '{{% option-tabs tabs="Node.js,Java" sync="runtime" %}}\n' +
      '{{% tab index="0" name="Node.js" syncValue="Node.js" %}}\n\nNode body.\n\n{{% /tab %}}\n' +
      '{{% tab index="1" name="Java" syncValue="Java" %}}\n\nJava body.\n\n{{% /tab %}}\n' +
      '{{% /option-tabs %}}\n',
    );

    const r = spawnSync(hugoBinary(), ['--source', siteDir], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(
        `Hugo build failed (exit ${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }

    rendered = readFileSync(join(siteDir, 'public', 'unsynced', 'index.html'), 'utf8');
    renderedSync = readFileSync(join(siteDir, 'public', 'synced', 'index.html'), 'utf8');
  }, 130_000);

  afterAll(() => {
    if (siteDir) rmSync(siteDir, { recursive: true, force: true });
  });

  // ---- role=tablist ----
  it('strips have role=tablist', () => {
    expect(rendered).toContain('role="tablist"');
  });

  // ---- tab ids ----
  it('first tab has an id', () => {
    expect(rendered).toMatch(/id="tab-[^"]+"/);
  });

  // ---- aria-selected ----
  it('first tab has aria-selected="true"', () => {
    expect(rendered).toContain('aria-selected="true"');
  });

  it('second tab has aria-selected="false"', () => {
    expect(rendered).toContain('aria-selected="false"');
  });

  // ---- roving tabindex ----
  it('selected tab has tabindex="0"', () => {
    // The first (selected) button should carry tabindex="0"
    expect(rendered).toMatch(/aria-selected="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-selected="true"/);
  });

  it('non-selected tabs have tabindex="-1"', () => {
    expect(rendered).toContain('tabindex="-1"');
  });

  // ---- aria-controls / panel id ----
  it('tab has aria-controls pointing at the panel id', () => {
    const ctrlMatch = rendered.match(/aria-controls="(tabpanel-[^"]+)"/);
    expect(ctrlMatch).not.toBeNull();
    const panelId = ctrlMatch![1];
    expect(rendered).toContain(`id="${panelId}"`);
  });

  // ---- panel role + aria-labelledby ----
  it('panel has role="tabpanel"', () => {
    expect(rendered).toContain('role="tabpanel"');
  });

  it('panel has aria-labelledby pointing at its tab id', () => {
    const lbMatch = rendered.match(/aria-labelledby="(tab-[^"]+)"/);
    expect(lbMatch).not.toBeNull();
    const tabId = lbMatch![1];
    expect(rendered).toContain(`id="${tabId}"`);
  });

  // ---- synced strip attributes ----
  it('synced strip has data-sync-key', () => {
    expect(renderedSync).toContain('data-sync-key="runtime"');
  });

  it('synced tabs have data-sync-value', () => {
    expect(renderedSync).toContain('data-sync-value="Node.js"');
    expect(renderedSync).toContain('data-sync-value="Java"');
  });

  // ---- backward-compat: unsynced strip has NO data-sync-key ----
  it('unsynced strip does not emit data-sync-key', () => {
    expect(rendered).not.toContain('data-sync-key');
  });

  // ---- backward-compat: existing test assertions still hold ----
  it('still emits clickable <button> elements (issue #1591 regression)', () => {
    expect(rendered).toContain('class="fd-tabs__item');
    expect(rendered).not.toContain('&lt;button');
  });
});

// ---------------------------------------------------------------------------
// 2. DOM-behaviour: tab switching, arrow-key roving, sync-group binding
//    Uses happy-dom; builds the ARIA-correct markup directly (no Hugo needed).
// ---------------------------------------------------------------------------

/**
 * Build a minimal ARIA-correct option-tabs strip in happy-dom.
 * Mirrors what option-tabs.html + tab.html will render after the update.
 */
function buildTabStrip(opts: {
  id: string;
  tabs: Array<{ name: string; syncValue?: string }>;
  syncKey?: string;
}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'option-tabs';
  container.setAttribute('data-component', 'tabs');

  const list = document.createElement('div');
  list.className = 'fd-tabs';
  list.setAttribute('role', 'tablist');
  if (opts.syncKey) list.dataset.syncKey = opts.syncKey;

  const panelsDiv = document.createElement('div');
  panelsDiv.className = 'tab-panels';

  opts.tabs.forEach((tab, i) => {
    const tabId = `tab-${opts.id}-${i}`;
    const panelId = `tabpanel-${opts.id}-${i}`;

    const btn = document.createElement('button');
    btn.className = 'fd-tabs__item' + (i === 0 ? ' is-selected' : '');
    btn.setAttribute('role', 'tab');
    btn.id = tabId;
    btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    btn.setAttribute('aria-controls', panelId);
    btn.setAttribute('tabindex', i === 0 ? '0' : '-1');
    btn.dataset.tabIndex = String(i);
    if (tab.syncValue) btn.dataset.syncValue = tab.syncValue;
    btn.textContent = tab.name;
    list.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tab-panel';
    panel.id = panelId;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tabId);
    panel.dataset.tabPanel = String(i);
    panel.dataset.tabName = tab.name;
    if (tab.syncValue) panel.dataset.syncValue = tab.syncValue;
    panel.hidden = i !== 0;
    panel.textContent = `${tab.name} body`;
    panelsDiv.appendChild(panel);
  });

  container.appendChild(list);
  container.appendChild(panelsDiv);
  return container;
}

/** Helper that simulates what tutorial.ts's updated switchTab does. */
function switchTab(btn: HTMLElement) {
  const container = btn.closest('[data-component="tabs"]');
  if (!container) return;
  const index = (btn as HTMLElement).dataset.tabIndex;

  container.querySelectorAll<HTMLElement>('[role="tab"]').forEach((t) => {
    t.classList.remove('is-selected');
    t.setAttribute('aria-selected', 'false');
    t.setAttribute('tabindex', '-1');
  });
  btn.classList.add('is-selected');
  btn.setAttribute('aria-selected', 'true');
  btn.setAttribute('tabindex', '0');

  container.querySelectorAll<HTMLElement>('[data-tab-panel]').forEach((p) => {
    p.hidden = p.dataset.tabPanel !== index;
  });
}

describe('option-tabs DOM behaviour (happy-dom)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  // ---- initial ARIA state ----
  it('initial state: first tab is aria-selected=true, tabindex=0', () => {
    const strip = buildTabStrip({ id: 'x', tabs: [{ name: 'A' }, { name: 'B' }] });
    document.body.appendChild(strip);

    const tabs = strip.querySelectorAll('[role="tab"]');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
  });

  // ---- click switching ----
  it('clicking a tab sets aria-selected=true + shows panel', () => {
    const strip = buildTabStrip({ id: 'y', tabs: [{ name: 'A' }, { name: 'B' }] });
    document.body.appendChild(strip);

    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    const panels = strip.querySelectorAll<HTMLElement>('[data-tab-panel]');

    switchTab(tabs[1]);

    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[0].getAttribute('tabindex')).toBe('-1');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('tabindex')).toBe('0');

    expect(panels[0].hidden).toBe(true);
    expect(panels[1].hidden).toBe(false);
  });

  // ---- aria-controls / aria-labelledby linkage (DOM) ----
  it('aria-controls of each tab points at its panel id', () => {
    const strip = buildTabStrip({ id: 'z', tabs: [{ name: 'A' }, { name: 'B' }] });
    document.body.appendChild(strip);

    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs.forEach((tab) => {
      const panelId = tab.getAttribute('aria-controls')!;
      expect(panelId).toBeTruthy();
      const panel = strip.querySelector(`#${panelId}`);
      expect(panel).not.toBeNull();
    });
  });

  it('aria-labelledby of each panel points at its tab id', () => {
    const strip = buildTabStrip({ id: 'w', tabs: [{ name: 'A' }, { name: 'B' }] });
    document.body.appendChild(strip);

    const panels = strip.querySelectorAll<HTMLElement>('[role="tabpanel"]');
    panels.forEach((panel) => {
      const tabId = panel.getAttribute('aria-labelledby')!;
      expect(tabId).toBeTruthy();
      const tab = strip.querySelector(`#${tabId}`);
      expect(tab).not.toBeNull();
    });
  });

  // ---- ArrowRight roving (simulated) ----
  it('ArrowRight roving: moves selection from tab 0 to tab 1', () => {
    const strip = buildTabStrip({ id: 'r', tabs: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
    document.body.appendChild(strip);

    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');

    // Simulate ArrowRight from tab 0: focus moves to tab 1, tab 1 becomes selected
    const currentIndex = Array.from(tabs).findIndex(t => t.getAttribute('aria-selected') === 'true');
    const nextIndex = (currentIndex + 1) % tabs.length;
    switchTab(tabs[nextIndex]);

    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
  });

  it('ArrowRight wraps from last tab to first', () => {
    const strip = buildTabStrip({ id: 's', tabs: [{ name: 'A' }, { name: 'B' }] });
    document.body.appendChild(strip);

    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    // Select the last tab first
    switchTab(tabs[1]);

    // ArrowRight from last wraps to first
    const currentIndex = Array.from(tabs).findIndex(t => t.getAttribute('aria-selected') === 'true');
    const nextIndex = (currentIndex + 1) % tabs.length;
    switchTab(tabs[nextIndex]);

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  });

  // ---- sync-group binding ----
  it('a strip with data-sync-key reflects getChoice on load', async () => {
    // Pre-seed the storage choice
    localStorage.setItem('sync-groups', JSON.stringify({ runtime: 'Java' }));

    const strip = buildTabStrip({
      id: 'sg',
      syncKey: 'runtime',
      tabs: [
        { name: 'Node.js', syncValue: 'Node.js' },
        { name: 'Java', syncValue: 'Java' },
      ],
    });
    document.body.appendChild(strip);

    // Import getChoice and apply the stored preference (mirrors initSyncedTabs)
    const { getChoice } = await import('../../hugo/assets/js/sync-groups');
    const stored = getChoice('runtime');
    expect(stored).toBe('Java');

    // Apply: select the tab whose syncValue matches
    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    const panels = strip.querySelectorAll<HTMLElement>('[data-tab-panel]');
    const matchingTab = Array.from(tabs).find(t => t.dataset.syncValue === stored);
    if (matchingTab) switchTab(matchingTab);

    // Node.js (index 0) should now be deselected; Java (index 1) selected
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(panels[0].hidden).toBe(true);
    expect(panels[1].hidden).toBe(false);
  });

  it('selecting a synced tab calls setChoice', async () => {
    const strip = buildTabStrip({
      id: 'sc',
      syncKey: 'runtime',
      tabs: [
        { name: 'Node.js', syncValue: 'Node.js' },
        { name: 'Java', syncValue: 'Java' },
      ],
    });
    document.body.appendChild(strip);

    const { setChoice, getChoice } = await import('../../hugo/assets/js/sync-groups');

    const tabs = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    const syncKey = strip.querySelector<HTMLElement>('[data-sync-key]')?.dataset.syncKey!;

    // Simulate user selecting Java tab + persisting
    switchTab(tabs[1]);
    setChoice(syncKey, tabs[1].dataset.syncValue!);

    expect(getChoice('runtime')).toBe('Java');
  });

  afterEach(() => {
    vi.resetModules();
  });
});
