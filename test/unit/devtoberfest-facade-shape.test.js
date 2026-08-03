// test/unit/devtoberfest-facade-shape.test.js
//
// Guards the column names/types on the devtoberfest cross-container facade
// after the planner migrated from naive Date+Time columns to UTC Timestamps
// with an IANA timezone column. The facade mirrors the deployed DTF_*_V1 view
// contract exactly — any drift here means the cross-container synonyms will
// mis-bind at HANA HDI deploy time.
//
// Uses cds.load() + cds.linked() only — no cds.test('serve') needed for a
// pure shape assertion.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const SESSION  = 'external.devtoberfest.Session';
const EDITION  = 'external.devtoberfest.Edition';
const CONSENT  = 'external.devtoberfest.Speakerconsent';

let model;

beforeAll(async () => {
  const raw = await cds.load('db/external/devtoberfest.cds');
  model = cds.linked(raw);
});

describe('devtoberfest facade — zone-aware Session columns', () => {
  it('Session has SCHEDULEDSTART : Timestamp', () => {
    const el = model.definitions[SESSION].elements.SCHEDULEDSTART;
    expect(el, 'SCHEDULEDSTART element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Session has SCHEDULEDTIMEZONE : String(50)', () => {
    const el = model.definitions[SESSION].elements.SCHEDULEDTIMEZONE;
    expect(el, 'SCHEDULEDTIMEZONE element must exist').toBeTruthy();
    expect(el.type).toBe('cds.String');
    expect(el.length).toBe(50);
  });

  it('Session has RECORDINGSTART : Timestamp', () => {
    const el = model.definitions[SESSION].elements.RECORDINGSTART;
    expect(el, 'RECORDINGSTART element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Session no longer has SCHEDULEDDATE', () => {
    expect(model.definitions[SESSION].elements.SCHEDULEDDATE).toBeUndefined();
  });

  it('Session no longer has SCHEDULEDTIME', () => {
    expect(model.definitions[SESSION].elements.SCHEDULEDTIME).toBeUndefined();
  });

  it('Session no longer has RECORDINGDATE', () => {
    expect(model.definitions[SESSION].elements.RECORDINGDATE).toBeUndefined();
  });
});

describe('devtoberfest facade — zone-aware Edition columns', () => {
  it('Edition has STARTSAT : Timestamp', () => {
    const el = model.definitions[EDITION].elements.STARTSAT;
    expect(el, 'STARTSAT element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Edition has ENDSAT : Timestamp', () => {
    const el = model.definitions[EDITION].elements.ENDSAT;
    expect(el, 'ENDSAT element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Edition has TIMEZONE : String(50)', () => {
    const el = model.definitions[EDITION].elements.TIMEZONE;
    expect(el, 'TIMEZONE element must exist').toBeTruthy();
    expect(el.type).toBe('cds.String');
    expect(el.length).toBe(50);
  });

  it('Edition no longer has STARTDATE', () => {
    expect(model.definitions[EDITION].elements.STARTDATE).toBeUndefined();
  });

  it('Edition no longer has ENDDATE', () => {
    expect(model.definitions[EDITION].elements.ENDDATE).toBeUndefined();
  });
});

describe('devtoberfest facade — Speakerconsent consent dates → Timestamp', () => {
  it('Speakerconsent CONSENTSENTDATE is Timestamp', () => {
    const el = model.definitions[CONSENT].elements.CONSENTSENTDATE;
    expect(el, 'CONSENTSENTDATE element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Speakerconsent CONSENTRECEIVEDDATE is Timestamp', () => {
    const el = model.definitions[CONSENT].elements.CONSENTRECEIVEDDATE;
    expect(el, 'CONSENTRECEIVEDDATE element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Timestamp');
  });

  it('Speakerconsent CONSENTRECEIVED (Boolean) is unchanged', () => {
    const el = model.definitions[CONSENT].elements.CONSENTRECEIVED;
    expect(el, 'CONSENTRECEIVED element must exist').toBeTruthy();
    expect(el.type).toBe('cds.Boolean');
  });
});
