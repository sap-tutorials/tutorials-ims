// test/hybrid/catalog-renderer-hana.test.js
//
// Real-HANA test for the catalog renderer + chrome shell. Exercises the LOB
// locator path in chrome-shell.js (BLOB read via raw SQL on HANA), which the
// in-memory SQLite unit tests cannot validate. Read-only — no INSERTs.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';
import { loadGroupContext } from '../../srv/lib/catalog-data.js';
import { createShellLoader, composeShell } from '../../srv/lib/chrome-shell.js';
import { renderGroupBody } from '../../srv/lib/catalog-renderer.js';

describe('catalog-renderer against real HANA', () => {
  let group;

  beforeAll(async () => {
    await cds.connect.to('db');
    const { Groups } = cds.entities('com.sap.developers.ims');
    [group] = await SELECT.from(Groups)
      .where({ status: 'ACTIVE', published: true })
      .columns('slug', 'title')
      .limit(1);
    if (!group) throw new Error('no published Group in DEV — run setup-dev-data first');
  });

  it('loadGroupContext returns the full row from HANA', async () => {
    const ctx = await loadGroupContext(group.slug);
    expect(ctx).not.toBeNull();
    expect(ctx.group.slug).toBe(group.slug);
    expect(ctx.group.title).toBe(group.title);
  });

  it('chrome shell loads from ContentFiles BLOB without LOB locator expiry', async () => {
    const namespace = 'com.sap.developers.ims';
    const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
    const getActiveVersion = async () => {
      const { ContentManifest } = cds.entities(namespace);
      const [row] = await SELECT.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .columns('version');
      return row?.version ?? null;
    };
    const loader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

    const shell = await loader.get();
    if (!shell) {
      console.warn('No __shell__ row in DEV ContentFiles; skipping shell composition test');
      return;
    }
    expect(shell.before).toContain('<head>');
    expect(shell.after).toContain('</body>');
  });

  it('end-to-end render produces HTML with body + chrome', async () => {
    const namespace = 'com.sap.developers.ims';
    const hanaTableName = () => `${namespace.replace(/\./g, '_').toUpperCase()}_CONTENTFILES`;
    const getActiveVersion = async () => {
      const { ContentManifest } = cds.entities(namespace);
      const [row] = await SELECT.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .columns('version');
      return row?.version ?? null;
    };
    const loader = createShellLoader({ namespace, hanaTableName, getActiveVersion });

    const ctx = await loadGroupContext(group.slug);
    const body = renderGroupBody(ctx);
    const shell = await loader.get();
    if (!shell) return; // covered above

    const html = composeShell(shell, body, {
      kind: 'group',
      slug: `group-${group.slug}`,
      title: group.title,
      description: ctx.group.description ?? '',
    });

    expect(html).toContain(group.title);
    expect(html).toContain(`data-page-kind="group"`);
    expect(html).toContain(`data-page-slug="group-${group.slug}"`);
    expect(html).toContain('class="group-wrapper"');
  }, 30000);
});
