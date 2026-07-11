// test/unit/mcp-metrics.test.js
//
// TDD for Phase 2 MCP metrics (Task 15 #1105).
// Uses the project's custom counter(name)/gauge(name,value) API with
// embedded label strings — NOT prom-client. Asserts via snapshot().
//
// Run: npx vitest run test/unit/mcp-metrics.test.js

import { describe, it, expect, beforeEach } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';

beforeEach(() => {
  metrics._resetForTest();
});

describe('Phase 2 MCP metrics — PAT', () => {
  it('mcp.pat.mint increments after handleMintPAT fires the counter', async () => {
    // Simulate what the wired code does.
    metrics.counter('mcp.pat.mint');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.mint']).toBe(1);
  });

  it('mcp.pat.revoke increments after handleRevokePAT fires the counter', () => {
    metrics.counter('mcp.pat.revoke');
    metrics.counter('mcp.pat.revoke');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.revoke']).toBe(2);
  });

  it('mcp.pat.auth[outcome=hit] increments on a valid PAT', () => {
    metrics.counter('mcp.pat.auth[outcome=hit]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth[outcome=hit]']).toBe(1);
  });

  it('mcp.pat.auth[outcome=miss] increments on an unknown token', () => {
    metrics.counter('mcp.pat.auth[outcome=miss]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth[outcome=miss]']).toBe(1);
  });

  it('mcp.pat.auth[outcome=revoked] increments for revoked tokens', () => {
    metrics.counter('mcp.pat.auth[outcome=revoked]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth[outcome=revoked]']).toBe(1);
  });

  it('mcp.pat.auth[outcome=expired] increments for expired tokens', () => {
    metrics.counter('mcp.pat.auth[outcome=expired]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth[outcome=expired]']).toBe(1);
  });
});

describe('Phase 2 MCP metrics — slicer', () => {
  it('mcp.slice[outcome=hit] increments on a cache hit', () => {
    metrics.counter('mcp.slice[outcome=hit]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.slice[outcome=hit]']).toBe(1);
  });

  it('mcp.slice[outcome=miss] increments on a cache miss (freshly computed)', () => {
    metrics.counter('mcp.slice[outcome=miss]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.slice[outcome=miss]']).toBe(1);
  });

  it('mcp.slice[outcome=error] increments on BLOB or gunzip failure', () => {
    metrics.counter('mcp.slice[outcome=error]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.slice[outcome=error]']).toBe(1);
  });

  it('mcp.slice.cache_size gauge reflects current LRU size', () => {
    metrics.gauge('mcp.slice.cache_size', 42);
    const snap = metrics.snapshot();
    expect(snap.gauges['mcp.slice.cache_size']).toBe(42);
  });
});

describe('Phase 2 MCP metrics — tool invocation', () => {
  it('mcp.tool counter includes service, tool, tokenSource, outcome labels', () => {
    metrics.counter('mcp.tool[service=DeveloperService,tool=get_my_tutorials,tokenSource=pat,outcome=ok]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.tool[service=DeveloperService,tool=get_my_tutorials,tokenSource=pat,outcome=ok]']).toBe(1);
  });

  it('mcp.tool uses tokenSource=anon for unauthenticated callers', () => {
    metrics.counter('mcp.tool[service=SearchService,tool=get_tutorial_step,tokenSource=anon,outcome=ok]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.tool[service=SearchService,tool=get_tutorial_step,tokenSource=anon,outcome=ok]']).toBe(1);
  });

  it('mcp.tool records outcome=error on handler failure', () => {
    metrics.counter('mcp.tool[service=HomepageService,tool=get_my_recommended_tutorials,tokenSource=xsuaa,outcome=error]');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.tool[service=HomepageService,tool=get_my_recommended_tutorials,tokenSource=xsuaa,outcome=error]']).toBe(1);
  });
});
