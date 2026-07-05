// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderBadge } from '../personalized-badge';

beforeEach(() => {
  document.body.innerHTML = '<div class="personalized-badge-slot" hidden></div>';
});

describe('renderBadge', () => {
  const slot = () => document.querySelector<HTMLElement>('.personalized-badge-slot')!;

  it('renders personalized copy with profile echo', () => {
    renderBadge(slot(), { role: 'developer', deployment: 'cloud', cloud: 'aws' }, 'personalized');
    expect(slot().hidden).toBe(false);
    expect(slot().textContent).toContain('Personalized for you');
    expect(slot().textContent).toContain('developer');
    expect(slot().textContent).toContain('AWS');
    expect(slot().querySelector('a[href="/me/#learning-preferences"]')).toBeTruthy();
    expect(slot().querySelector('a[href="?default=1"]')).toBeTruthy();
  });

  it('omits profile clause when all fields null', () => {
    renderBadge(slot(), { role: null, deployment: null, cloud: null }, 'personalized');
    expect(slot().textContent).toContain('Personalized for you');
    expect(slot().textContent).not.toContain('null');
  });

  it('renders default-view copy in default mode', () => {
    renderBadge(slot(), null, 'default');
    expect(slot().textContent).toContain('Viewing the default homepage');
    expect(slot().textContent).toContain('Personalize again');
  });
});
