import fs from 'node:fs';
import path from 'node:path';

const xsApp = JSON.parse(fs.readFileSync(path.resolve('approuter/xs-app.json'), 'utf8'));

describe('channel-submissions approuter route', () => {
  const route = xsApp.routes.find((r) => r.source === '^/channel-submissions/(.*)$');

  test('route exists, targets srv-api under xsuaa', () => {
    expect(route).toBeTruthy();
    expect(route.destination).toBe('srv-api');
    expect(route.authenticationType).toBe('xsuaa');
  });

  test('route does not set csrfProtection (AppRouter default CSRF-on required)', () => {
    expect(route).not.toHaveProperty('csrfProtection');
  });

  test('route sits before the /api catch-all and the final static catch-all', () => {
    const idx = xsApp.routes.indexOf(route);
    const apiCatchAll = xsApp.routes.findIndex((r) => r.source === '^/api/(.*)$');
    const staticCatchAll = xsApp.routes.findIndex((r) => r.source === '^(.*)$');
    if (apiCatchAll !== -1) expect(idx).toBeLessThan(apiCatchAll);
    expect(idx).toBeLessThan(staticCatchAll);
  });
});
