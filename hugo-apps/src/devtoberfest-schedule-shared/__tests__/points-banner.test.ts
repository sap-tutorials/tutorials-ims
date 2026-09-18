// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createApp, h } from 'vue';
import PointsBanner from '../PointsBanner.vue';

/**
 * #2409 — the "Sign in" link on the Devtoberfest schedule/sessions/calendar
 * pages must carry the current page as returnTo. A bare /login link let
 * login-redirect.html default returnTo to '/', bouncing the visitor to the
 * homepage instead of back to the Devtoberfest page they came from.
 */
function mount(props: Record<string, unknown>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render: () => h(PointsBanner as any, props) });
  app.mount(host);
  return { host, app };
}

const baseProps = { earnedPoints: 0, maxPoints: 100, completeCount: 0 };

beforeEach(() => {
  window.history.replaceState({}, '', '/devtoberfest/schedule/?week=2');
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('PointsBanner sign-in link', () => {
  it('anonymous: Sign in link carries the current page as returnTo', () => {
    const { host } = mount({ ...baseProps, isAuthenticated: false });
    const link = host.querySelector('.points-banner__signin-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('Sign in');
    expect(link.getAttribute('href')).toBe(
      '/login?returnTo=' + encodeURIComponent('/devtoberfest/schedule/?week=2'),
    );
  });

  it('never links to a bare /login (which would drop the return path)', () => {
    const { host } = mount({ ...baseProps, isAuthenticated: false });
    const link = host.querySelector('.points-banner__signin-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).not.toBe('/login');
  });

  it('authenticated but not joined: shows Join link, no Sign in', () => {
    const { host } = mount({ ...baseProps, isAuthenticated: true, joined: false });
    const link = host.querySelector('.points-banner__signin-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/devtoberfest/');
    expect(link.textContent).toContain('Join');
  });
});
