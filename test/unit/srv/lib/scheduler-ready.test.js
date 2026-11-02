import { describe, it, expect, beforeEach } from 'vitest';
import { markSchedulerReady, isSchedulerReady, _resetForTests, computeReadiness } from '../../../../srv/lib/scheduler-ready.js';

describe('scheduler-ready latch', () => {
  beforeEach(() => _resetForTests());
  it('defaults to false before init', () => {
    expect(isSchedulerReady()).toBe(false);
  });
  it('flips to true after markSchedulerReady()', () => {
    markSchedulerReady();
    expect(isSchedulerReady()).toBe(true);
  });
  it('stays true on a second mark (idempotent, never flips back)', () => {
    markSchedulerReady();
    markSchedulerReady();
    expect(isSchedulerReady()).toBe(true);
  });
  it('_resetForTests() clears it back to false', () => {
    markSchedulerReady();
    _resetForTests();
    expect(isSchedulerReady()).toBe(false);
  });
});

describe('computeReadiness', () => {
  it('ready when scheduler armed and db ok', () => {
    expect(computeReadiness({ schedulerArmed: true, dbOk: true }))
      .toEqual({ ready: true, status: 'ready', scheduler: 'armed', db: 'connected' });
  });
  it('not-ready (pending) when scheduler not armed, even if db ok', () => {
    expect(computeReadiness({ schedulerArmed: false, dbOk: true }))
      .toEqual({ ready: false, status: 'not-ready', scheduler: 'pending', db: 'connected' });
  });
  it('not-ready (db error) when db check failed, even if scheduler armed', () => {
    expect(computeReadiness({ schedulerArmed: true, dbOk: false }))
      .toEqual({ ready: false, status: 'not-ready', scheduler: 'armed', db: 'error' });
  });
  it('not-ready when both false', () => {
    expect(computeReadiness({ schedulerArmed: false, dbOk: false }).ready).toBe(false);
  });
});
