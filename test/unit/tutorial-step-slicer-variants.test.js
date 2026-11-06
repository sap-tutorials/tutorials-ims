// Unit tests for filterVariants — pure OPTION-block filtering.
// No DB or CDS setup required; filterVariants lives in option-filter.js,
// which is a pure-JS module with zero CDS/DB dependencies.
//
// This test file covers Task 6 (MCP variants preference + analytics).

import { describe, it, expect } from 'vitest';

// filterVariants is exported from the pure helper; tutorial-step-slicer.js
// re-exports it. Test via the pure module to stay DB-free.
import { filterVariants } from '../../packages/mcp/option-filter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const SYNC_RUNTIME_MD = [
  'Some intro text.',
  '',
  '[OPTION BEGIN [Java] sync=runtime]',
  'Run `mvn spring-boot:run`.',
  '[OPTION END]',
  '',
  '[OPTION BEGIN [Node.js] sync=runtime]',
  'Run `npm start`.',
  '[OPTION END]',
  '',
  'Some footer text.',
].join('\n');

const SYNC_RUNTIME_MULTI_LINE_MD = [
  '[OPTION BEGIN [Java] sync=runtime]',
  'First Java line.',
  '',
  'Second Java line.',
  '[OPTION END]',
  '',
  '[OPTION BEGIN [Node.js] sync=runtime]',
  'Node line.',
  '[OPTION END]',
].join('\n');

const NO_SYNC_MD = [
  '[OPTION BEGIN [Option A]]',
  'Content A.',
  '[OPTION END]',
  '',
  '[OPTION BEGIN [Option B]]',
  'Content B.',
  '[OPTION END]',
].join('\n');

const MIXED_MD = [
  '[OPTION BEGIN [Java] sync=runtime]',
  'Java content.',
  '[OPTION END]',
  '',
  '[OPTION BEGIN [Node.js] sync=runtime]',
  'Node content.',
  '[OPTION END]',
  '',
  'Gap paragraph.',
  '',
  '[OPTION BEGIN [Trial]]',
  'Trial account.',
  '[OPTION END]',
  '',
  '[OPTION BEGIN [Free Tier]]',
  'Free tier.',
  '[OPTION END]',
].join('\n');

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('filterVariants', () => {
  describe('with a matching sync= preference', () => {
    it('keeps only the Java variant when runtime=Java', () => {
      const result = filterVariants(SYNC_RUNTIME_MD, { runtime: 'java' });
      expect(result).toContain('Run `mvn spring-boot:run`.');
      expect(result).not.toContain('Run `npm start`.');
      // Should NOT contain OPTION markers
      expect(result).not.toContain('[OPTION BEGIN');
      expect(result).not.toContain('[OPTION END]');
      // Surrounding text preserved
      expect(result).toContain('Some intro text.');
      expect(result).toContain('Some footer text.');
    });

    it('keeps only the Node.js variant when runtime=node.js', () => {
      const result = filterVariants(SYNC_RUNTIME_MD, { runtime: 'node.js' });
      expect(result).toContain('Run `npm start`.');
      expect(result).not.toContain('Run `mvn spring-boot:run`.');
      expect(result).not.toContain('[OPTION BEGIN');
    });

    it('keeps multi-line variant content intact', () => {
      const result = filterVariants(SYNC_RUNTIME_MULTI_LINE_MD, { runtime: 'java' });
      expect(result).toContain('First Java line.');
      expect(result).toContain('Second Java line.');
      expect(result).not.toContain('Node line.');
    });
  });

  describe('with empty variants object {}', () => {
    it('returns all variants with "#### Option: <label>" headers for sync= groups', () => {
      const result = filterVariants(SYNC_RUNTIME_MD, {});
      expect(result).toContain('#### Option: Java');
      expect(result).toContain('Run `mvn spring-boot:run`.');
      expect(result).toContain('#### Option: Node.js');
      expect(result).toContain('Run `npm start`.');
      expect(result).not.toContain('[OPTION BEGIN');
      expect(result).not.toContain('[OPTION END]');
    });
  });

  describe('with no matching preset (unknown preference key)', () => {
    it('keeps all variants with headers when the preference key does not match any sync=', () => {
      // runtime:java preference on a group without sync= — falls back to all
      const result = filterVariants(NO_SYNC_MD, { runtime: 'java' });
      expect(result).toContain('#### Option: Option A');
      expect(result).toContain('Content A.');
      expect(result).toContain('#### Option: Option B');
      expect(result).toContain('Content B.');
    });
  });

  describe('OPTION groups without sync= attribute', () => {
    it('always renders as labelled fallback with "#### Option: <label>" headers', () => {
      const result = filterVariants(NO_SYNC_MD, {});
      expect(result).toContain('#### Option: Option A');
      expect(result).toContain('Content A.');
      expect(result).toContain('#### Option: Option B');
      expect(result).toContain('Content B.');
    });
  });

  describe('mixed: some groups with sync=, some without', () => {
    it('filters the sync= group and labels the non-sync group', () => {
      const result = filterVariants(MIXED_MD, { runtime: 'java' });
      // Synced group: only Java variant
      expect(result).toContain('Java content.');
      expect(result).not.toContain('Node content.');
      // Non-sync group: kept with labels
      expect(result).toContain('#### Option: Trial');
      expect(result).toContain('Trial account.');
      expect(result).toContain('#### Option: Free Tier');
      expect(result).toContain('Free tier.');
    });
  });

  describe('markdown without any OPTION blocks', () => {
    it('returns the markdown unchanged', () => {
      const plain = 'Just plain text.\n\nNo options here.';
      expect(filterVariants(plain, { runtime: 'java' })).toBe(plain);
    });
  });

  describe('preference value that does not match any variant label', () => {
    it('keeps all variants with headers (no match = keep all)', () => {
      const result = filterVariants(SYNC_RUNTIME_MD, { runtime: 'python' });
      // Python not in the group → fall back to all with headers
      expect(result).toContain('#### Option: Java');
      expect(result).toContain('Run `mvn spring-boot:run`.');
      expect(result).toContain('#### Option: Node.js');
      expect(result).toContain('Run `npm start`.');
    });
  });
});
