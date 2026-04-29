// test/admin-annotations.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('UI Annotations in $metadata', () => {
  let metadata;

  it('fetches metadata successfully', async () => {
    const { status, data } = await project.get('/admin/$metadata', adminAuth);
    expect(status).toBe(200);
    metadata = data;
  });

  describe('Events annotations', () => {
    it('has HeaderInfo annotation', () => {
      expect(metadata).toContain('UI.HeaderInfo');
    });

    it('has SelectionFields annotation', () => {
      expect(metadata).toContain('UI.SelectionFields');
    });

    it('has LineItem annotation', () => {
      expect(metadata).toContain('UI.LineItem');
    });
  });

  describe('Missions annotations', () => {
    it('has HeaderInfo for Missions', () => {
      expect(metadata).toContain('TypeName');
    });

    it('has ValueList annotation for primaryTagRef', () => {
      expect(metadata).toContain('Common.ValueList');
      expect(metadata).toContain('Tags');
    });
  });

  describe('Groups annotations', () => {
    it('has Groups LineItem annotation', () => {
      expect(metadata).toContain('Group');
    });
  });

  describe('Tutorials annotations', () => {
    it('has Tutorials LineItem annotation', () => {
      expect(metadata).toContain('Tutorial');
    });
  });
});
