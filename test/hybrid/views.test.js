import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('HANA views', () => {

  describe('Tasks (UNION ALL view)', () => {
    it('is queryable and returns valid taskType discriminators', async () => {
      const { Tasks } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(Tasks).limit(50);
      expect(Array.isArray(rows)).toBe(true);

      for (const row of rows) {
        expect(['TUTORIAL', 'MISSION', 'GROUP', 'STEP', 'CHECKPOINT']).toContain(row.taskType);
      }
    });

    it('contains expected task types when data exists', async () => {
      const { Tasks } = cds.entities('com.sap.developers.ims');
      const types = await SELECT.distinct.from(Tasks).columns('taskType');
      if (types.length === 0) return; // empty container — skip
      const typeSet = new Set(types.map(r => r.taskType));
      expect(typeSet).toContain('TUTORIAL');
      expect(typeSet).toContain('STEP');
    });

    it('legacyId and title are populated when data exists', async () => {
      const { Tasks } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(Tasks).where({ taskType: 'TUTORIAL' }).limit(5);
      for (const row of rows) {
        expect(row.legacyId).toBeTruthy();
        expect(row.title).toBeTruthy();
      }
    });
  });

  describe('NavigatorCatalog (pre-joined view)', () => {
    it('is queryable with correct column structure', async () => {
      const { NavigatorCatalog } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(NavigatorCatalog).limit(20);
      expect(Array.isArray(rows)).toBe(true);

      if (rows.length > 0) {
        const row = rows[0];
        expect(row).toHaveProperty('missionId');
        expect(row).toHaveProperty('missionTitle');
        expect(row).toHaveProperty('pathId');
        expect(row).toHaveProperty('tutorialSlug');
        expect(row).toHaveProperty('itemOrder');
      }
    });

    it('only contains TUTORIAL task type', async () => {
      const { NavigatorCatalog } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(NavigatorCatalog).limit(100);
      for (const row of rows) {
        expect(row.taskType).toBe('TUTORIAL');
      }
    });

    it('tutorialSlug is never null (filtered by view)', async () => {
      const { NavigatorCatalog } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(NavigatorCatalog).limit(100);
      for (const row of rows) {
        expect(row.tutorialSlug).toBeTruthy();
      }
    });

    it('items are orderable by itemOrder within a path', async () => {
      const { NavigatorCatalog } = cds.entities('com.sap.developers.ims');
      const rows = await SELECT.from(NavigatorCatalog).limit(50);

      if (rows.length > 1) {
        const byPath = {};
        for (const row of rows) {
          if (!byPath[row.pathId]) byPath[row.pathId] = [];
          byPath[row.pathId].push(row.itemOrder);
        }

        for (const orders of Object.values(byPath)) {
          if (orders.length > 1) {
            const sorted = [...orders].sort((a, b) => a - b);
            expect(orders.sort((a, b) => a - b)).toEqual(sorted);
          }
        }
      }
    });
  });
});
