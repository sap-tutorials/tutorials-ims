// test/unit/kg-concept-loader.test.js
// Sanity tests for srv/lib/kg-concept-loader.js — the byte-level
// Buffer→Float32Array decoder must round-trip cleanly with the way the
// extractor stores embeddings, and gracefully reject malformed input.

import { describe, it, expect } from 'vitest';
import { bufferToFloat32Array } from '../../srv/lib/kg-concept-loader.js';

describe('bufferToFloat32Array', () => {
  it('returns null for null buffer', () => {
    expect(bufferToFloat32Array(null)).toBeNull();
  });

  it('returns null for undefined buffer', () => {
    expect(bufferToFloat32Array(undefined)).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(bufferToFloat32Array(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for misaligned buffer (length not multiple of 4)', () => {
    // 7 bytes -> not a valid Float32 packed sequence
    expect(bufferToFloat32Array(Buffer.alloc(7))).toBeNull();
    expect(bufferToFloat32Array(Buffer.alloc(1))).toBeNull();
    expect(bufferToFloat32Array(Buffer.alloc(5))).toBeNull();
  });

  it('decodes an aligned 12-byte buffer to a 3-element Float32Array', () => {
    // Round-trip: pack three known floats the same way the extractor does.
    const expected = new Float32Array([1.5, -2.25, 3.75]);
    const buf = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
    expect(buf.byteLength).toBe(12);

    const got = bufferToFloat32Array(buf);
    expect(got).toBeInstanceOf(Float32Array);
    expect(got.length).toBe(3);
    expect(got[0]).toBeCloseTo(1.5, 6);
    expect(got[1]).toBeCloseTo(-2.25, 6);
    expect(got[2]).toBeCloseTo(3.75, 6);
  });

  it('accepts a Uint8Array (not just Buffer)', () => {
    const expected = new Float32Array([0.5, 0.25]);
    const u8 = new Uint8Array(expected.buffer.slice(0));
    const got = bufferToFloat32Array(u8);
    expect(got).toBeInstanceOf(Float32Array);
    expect(got.length).toBe(2);
    expect(got[0]).toBeCloseTo(0.5, 6);
    expect(got[1]).toBeCloseTo(0.25, 6);
  });
});
