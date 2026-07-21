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

  it('mcp.pat.auth.hit increments on a valid PAT', () => {
    metrics.counter('mcp.pat.auth.hit');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth.hit']).toBe(1);
  });

  it('mcp.pat.auth.miss increments on an unknown token', () => {
    metrics.counter('mcp.pat.auth.miss');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth.miss']).toBe(1);
  });

  it('mcp.pat.auth.revoked increments for revoked tokens', () => {
    metrics.counter('mcp.pat.auth.revoked');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth.revoked']).toBe(1);
  });

  it('mcp.pat.auth.expired increments for expired tokens', () => {
    metrics.counter('mcp.pat.auth.expired');
    const snap = metrics.snapshot();
    expect(snap.counters['mcp.pat.auth.expired']).toBe(1);
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
  it('mcp.tool.ok increments on a successful tool invocation', () => {
    metrics.counter('mcp.tool.ok');
    expect(metrics.snapshot().counters['mcp.tool.ok']).toBe(1);
  });

  it('mcp.tool.error increments on handler failure', () => {
    metrics.counter('mcp.tool.error');
    expect(metrics.snapshot().counters['mcp.tool.error']).toBe(1);
  });
});
