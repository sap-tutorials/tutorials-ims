import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = join(process.cwd(), 'app', 'admin-shell', 'webapp', 'manifest.json');

describe('admin-shell #1034 route', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const routing = m['sap.ui5'].routing;

  it('registers a contentModeration route with pattern "content-moderation"', () => {
    const route = routing.routes.find(r => r.name === 'contentModeration');
    expect(route).toBeTruthy();
    expect(route.pattern).toBe('content-moderation');
  });

  it('has a matching contentModerationTarget with prefix "cm"', () => {
    const t = routing.targets.contentModerationTarget;
    expect(t).toBeTruthy();
    expect(t.prefix).toBe('cm');
  });

  it('registers contentModerationComponent in componentUsages block', () => {
    const cu = m['sap.ui5'].componentUsages;
    expect(cu?.contentModerationComponent).toBeTruthy();
    expect(cu.contentModerationComponent.name).toBe('sap.tutorials.admin.contentModeration');
  });
});
