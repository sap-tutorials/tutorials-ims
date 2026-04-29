import { describe, it, expect, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';

describe.runIf(isSafeForWrites())('Admin CRUD operations (hybrid)', () => {
  const cleanupIds = {
    events: [],
    tags: [],
    imsConfig: []
  };

  afterAll(async () => {
    const { Events, Tags, ImsConfig } = cds.entities('com.sap.developers.ims');
    for (const id of cleanupIds.events) {
      await DELETE.from(Events).where({ ID: id });
    }
    for (const id of cleanupIds.tags) {
      await DELETE.from(Tags).where({ ID: id });
    }
    for (const id of cleanupIds.imsConfig) {
      await DELETE.from(ImsConfig).where({ ID: id });
    }
  });

  describe('Events entity CRUD', () => {
    it('can read existing events', async () => {
      const { Events } = cds.entities('com.sap.developers.ims');
      const events = await SELECT.from(Events).limit(5);
      expect(events.length).toBeGreaterThan(0);

      const event = events[0];
      expect(event).toHaveProperty('ID');
      expect(event).toHaveProperty('legacyId');
      expect(event).toHaveProperty('name');
    });

    it('can CREATE a test event', async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const { Events } = cds.entities('com.sap.developers.ims');

      const legacyId = await getNextLegacyId('Events', db);
      const event = {
        name: `${TEST_PREFIX}Hybrid Test Event`,
        legacyId,
        startDate: '2099-01-01T00:00:00Z',
        endDate: '2099-01-02T00:00:00Z'
      };

      await INSERT.into(Events).entries(event);
      const created = await SELECT.one.from(Events).where({ legacyId });

      expect(created).toBeTruthy();
      expect(created.name).toBe(`${TEST_PREFIX}Hybrid Test Event`);

      cleanupIds.events.push(created.ID);
    });

    it('can UPDATE a test event', async () => {
      const { Events } = cds.entities('com.sap.developers.ims');

      // Use the event created in the previous test
      const testEvent = await SELECT.one.from(Events)
        .where({ name: { like: `${TEST_PREFIX}%` } });

      if (testEvent) {
        await UPDATE(Events, testEvent.ID).set({
          name: `${TEST_PREFIX}Updated Hybrid Event`
        });

        const updated = await SELECT.one.from(Events, testEvent.ID);
        expect(updated.name).toBe(`${TEST_PREFIX}Updated Hybrid Event`);
      }
    });

    it('can DELETE a test event', async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const { Events } = cds.entities('com.sap.developers.ims');

      const legacyId = await getNextLegacyId('Events', db);
      await INSERT.into(Events).entries({
        name: `${TEST_PREFIX}Deletable Event`,
        legacyId
      });

      const created = await SELECT.one.from(Events).where({ legacyId });
      expect(created).toBeTruthy();

      await DELETE.from(Events).where({ ID: created.ID });
      const deleted = await SELECT.one.from(Events, created.ID);
      expect(deleted).toBeFalsy();
    });
  });

  describe('Tutorials entity (read-focused)', () => {
    it('tutorials have required fields populated', async () => {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const tutorials = await SELECT.from(Tutorials)
        .limit(10);

      expect(tutorials.length).toBeGreaterThan(0);
      for (const t of tutorials) {
        expect(t.legacyId).toBeTruthy();
        expect(t.title).toBeTruthy();
      }
    });

    it('tutorials with steps have valid step ordering', async () => {
      const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');

      const tutorial = await SELECT.one.from(Tutorials);
      if (!tutorial) return;

      const steps = await SELECT.from(Steps)
        .where({ tutorial_ID: tutorial.ID })
        .orderBy('stepOrder');

      if (steps.length > 1) {
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i].stepOrder).toBeGreaterThan(steps[i - 1].stepOrder);
        }
      }
    });
  });

  describe('Missions entity (read-focused)', () => {
    it('missions have required structure', async () => {
      const { Missions } = cds.entities('com.sap.developers.ims');
      const missions = await SELECT.from(Missions).limit(10);
      expect(missions.length).toBeGreaterThan(0);

      for (const m of missions) {
        expect(m).toHaveProperty('ID');
        expect(m).toHaveProperty('legacyId');
        expect(m).toHaveProperty('title');
      }
    });

    it('missions link to completion paths', async () => {
      const { Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

      const mission = await SELECT.one.from(Missions);
      if (!mission) return;

      const paths = await SELECT.from(CompletionPaths)
        .where({ mission_ID: mission.ID });

      // Not all missions have paths, but if they do they should be valid
      for (const path of paths) {
        expect(path.mission_ID).toBe(mission.ID);
        expect(path).toHaveProperty('legacyId');
      }
    });
  });

  describe('Tags entity CRUD', () => {
    it('can read tags', async () => {
      const { Tags } = cds.entities('com.sap.developers.ims');
      const tags = await SELECT.from(Tags).limit(10);
      expect(Array.isArray(tags)).toBe(true);
    });

    it('can CREATE and DELETE a test tag', async () => {
      const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const { Tags } = cds.entities('com.sap.developers.ims');

      const legacyId = await getNextLegacyId('Tags', db);
      await INSERT.into(Tags).entries({
        name: `${TEST_PREFIX}hybrid-tag`,
        legacyId
      });

      const created = await SELECT.one.from(Tags).where({ legacyId });
      expect(created).toBeTruthy();
      expect(created.name).toBe(`${TEST_PREFIX}hybrid-tag`);

      cleanupIds.tags.push(created.ID);
    });
  });

  describe('ImsConfig entity', () => {
    it('can read configuration entries', async () => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const configs = await SELECT.from(ImsConfig).limit(10);
      expect(Array.isArray(configs)).toBe(true);
    });

    it('can CREATE a test config entry', async () => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');

      // ImsConfig sequence not yet deployed — use modular timestamp to stay within Integer range
      const legacyId = Math.floor(Date.now() / 1000) % 1000000;
      await INSERT.into(ImsConfig).entries({
        key: `${TEST_PREFIX}hybrid_test_key`,
        value: 'test_value',
        legacyId
      });

      const created = await SELECT.one.from(ImsConfig).where({ legacyId });
      expect(created).toBeTruthy();
      expect(created.key).toBe(`${TEST_PREFIX}hybrid_test_key`);

      cleanupIds.imsConfig.push(created.ID);
    });
  });
});
