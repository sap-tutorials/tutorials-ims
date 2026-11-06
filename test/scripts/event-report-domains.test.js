import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { computeDomainBreakdown, renderDomainSection, assertCfTargetProd } from '../../scripts/event-report.mjs';

cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID = '33333333-cccc-0000-0000-000000000001';
const PATH_ID = '44444444-cccc-0000-0000-000000000001';
const TUT = { ID: '55555555-cccc-0000-0000-000000000001', legacyId: 90001, slug: 'dom-tut', title: 'Domain Tutorial', stepCount: 2 };
const WIN_START = '2026-11-01T00:00:00.000Z';
const WIN_END = '2026-11-30T23:59:59.000Z';
const IN = '2026-11-05T12:00:00.000Z';

describe('sections 3-4 — domain + audience breakdown (seeded db)', () => {
  let event;
  let tutorials;
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials, Users, TaskRecords } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([TUT]);
    await INSERT.into(Missions).entries({ ID: MISSION_ID, legacyId: 9003, title: 'M3', slug: 'm3', published: true });
    await INSERT.into(Events).entries({
      ID: 'eeee0000-cccc-0000-0000-000000000903', legacyId: 903, name: 'Domain Event', eventType: 'OTHER',
      mission_ID: MISSION_ID, startDate: WIN_START, endDate: WIN_END,
    });
    await INSERT.into(CompletionPaths).entries({ ID: PATH_ID, legacyId: 9053, name: 'T', mission_ID: MISSION_ID });
    await INSERT.into(CompletionPathItems).entries({
      ID: 'dddd0000-cccc-0000-0000-000000000001', path_ID: PATH_ID, itemOrder: 1,
      taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT.ID,
    });
    await INSERT.into(Users).entries([
      { ID: 'c0000000-cccc-0000-0000-00000000000a', email: 'a@gmail.com' },
      { ID: 'c0000000-cccc-0000-0000-00000000000b', email: 'b@gmail.com' },
      { ID: 'c0000000-cccc-0000-0000-00000000000c', email: 'c@sap.com' },
    ]);
    // gmail: 2 users, 3 completions total; sap: 1 user, 1 completion.
    await INSERT.into(TaskRecords).entries([
      { ID: 'd0000000-cccc-0000-0000-000000000001', user_ID: 'c0000000-cccc-0000-0000-00000000000a', taskLegacyId: TUT.legacyId, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1 },
      { ID: 'd0000000-cccc-0000-0000-000000000002', user_ID: 'c0000000-cccc-0000-0000-00000000000a', taskLegacyId: TUT.legacyId, taskType: 'TUTORIAL', status: 'SUPERSEDED', completionDate: IN, attemptNumber: 1 },
      { ID: 'd0000000-cccc-0000-0000-000000000003', user_ID: 'c0000000-cccc-0000-0000-00000000000b', taskLegacyId: TUT.legacyId, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1 },
      { ID: 'd0000000-cccc-0000-0000-000000000004', user_ID: 'c0000000-cccc-0000-0000-00000000000c', taskLegacyId: TUT.legacyId, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1 },
    ]);

    event = await SELECT.one.from(Events).where({ legacyId: 903 });
    tutorials = [{ ID: TUT.ID, legacyId: TUT.legacyId, title: TUT.title, totalSteps: 2 }];
  });

  it('groups completions by email domain with per-user average', async () => {
    const db = await cds.connect.to('db');
    const b = await computeDomainBreakdown(event, db);
    const gmail = b.domains.find((d) => d.domain === 'gmail.com');
    expect(gmail.users).toBe(2);
    expect(gmail.completions).toBe(3);
    expect(gmail.perUser).toBeCloseTo(1.5, 1);
  });

  it('splits SAP employees from external', async () => {
    const db = await cds.connect.to('db');
    const b = await computeDomainBreakdown(event, db);
    expect(b.sap.users).toBe(1);
    expect(b.sap.completions).toBe(1);
    expect(b.external.users).toBe(2);
    expect(b.external.completions).toBe(3);
  });

  it('renders a gmail row in the domain section', async () => {
    const db = await cds.connect.to('db');
    const b = await computeDomainBreakdown(event, db);
    const md = renderDomainSection(b);
    expect(md).toContain('gmail.com');
  });

  it('cf-target guard dies unless space is prod', () => {
    const runDev = () => ({ status: 0, stdout: 'API endpoint: https://api.cf.eu10-005.hana.ondemand.com\norg: o\nspace: dev\n' });
    expect(() => assertCfTargetProd(runDev)).toThrow(/prod/i);
  });

  it('cf-target guard passes when space is prod', () => {
    const runProd = () => ({ status: 0, stdout: 'API endpoint: https://api.cf.eu10-005.hana.ondemand.com\norg: o\nspace: prod\n' });
    expect(() => assertCfTargetProd(runProd)).not.toThrow();
  });

  it('counts the full windowed completion set, incl. completions not under any track (matches §1 hero)', async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    // A completion for a tutorial that is NOT in the event's track set, but IS
    // a windowed TUTORIAL completion — §1 hero counts it, so §3-4 must too.
    await INSERT.into(Users).entries({ ID: 'c0000000-cccc-0000-0000-00000000000e', email: 'e@zalando.de' });
    await INSERT.into(TaskRecords).entries({
      ID: 'd0000000-cccc-0000-0000-00000000000e', user_ID: 'c0000000-cccc-0000-0000-00000000000e',
      taskLegacyId: 99999, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1,
    });
    const b = await computeDomainBreakdown(event, db);
    // 4 track completions (gmail x3, sap x1) + 1 off-track (zalando) = 5 total.
    const sum = b.domains.reduce((s, d) => s + d.completions, 0);
    expect(sum).toBe(5);
    expect(b.domains.find((d) => d.domain === 'zalando.de')).toBeTruthy();
  });

  it('excludes unknown/anonymized emails from the SAP-vs-external split', async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'c0000000-cccc-0000-0000-00000000000f', email: null });
    await INSERT.into(TaskRecords).entries({
      ID: 'd0000000-cccc-0000-0000-00000000000f', user_ID: 'c0000000-cccc-0000-0000-00000000000f',
      taskLegacyId: 99999, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1,
    });
    const b = await computeDomainBreakdown(event, db);
    const totalSplit = b.sap.completions + b.external.completions;
    const allCompletions = b.domains.reduce((s, d) => s + d.completions, 0);
    // the null-email completion is in the domain table (as unknown) but NOT in the sap/external split
    expect(totalSplit).toBeLessThan(allCompletions);
    expect(b.sap.users + b.external.users).not.toContain(undefined);
  });

  it('rolls multiple sub-domains of one org into a single labeled row', async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: 'c0000000-cccc-0000-0000-0000000000e1', email: 'x@gds.ey.com' },
      { ID: 'c0000000-cccc-0000-0000-0000000000e2', email: 'y@it.ey.com' },
    ]);
    await INSERT.into(TaskRecords).entries([
      { ID: 'd0000000-cccc-0000-0000-0000000000e1', user_ID: 'c0000000-cccc-0000-0000-0000000000e1', taskLegacyId: 99999, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1 },
      { ID: 'd0000000-cccc-0000-0000-0000000000e2', user_ID: 'c0000000-cccc-0000-0000-0000000000e2', taskLegacyId: 99999, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: IN, attemptNumber: 1 },
    ]);
    const orgMap = { EY: ['gds.ey.com', 'it.ey.com'] };
    const b = await computeDomainBreakdown(event, db, { orgMap });
    const ey = b.domains.find((d) => d.domain === 'EY');
    expect(ey).toBeTruthy();
    expect(ey.users).toBe(2);
    expect(ey.completions).toBe(2);
    // the raw sub-domains must NOT also appear as separate rows
    expect(b.domains.find((d) => d.domain === 'gds.ey.com')).toBeFalsy();
    expect(b.domains.find((d) => d.domain === 'it.ey.com')).toBeFalsy();
  });

  it('renders a per-user engagement callout for the most engaged domains', async () => {
    const db = await cds.connect.to('db');
    const b = await computeDomainBreakdown(event, db);
    const md = renderDomainSection(b);
    expect(md).toMatch(/engag/i); // "Notable: highly engaged" callout prose
  });
});
