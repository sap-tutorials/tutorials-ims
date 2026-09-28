// Shared arg validators for MCP curated handlers. One file so the "did we
// clamp?" audit is a single grep. Every MCP handler should call at least
// clampLimit and/or assertEnum at the top; range checks via assertRange.

export function assertRange({ name, value, min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
}

export function assertEnum({ name, value, allowed }) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
}

export function clampLimit(value, defaultN, maxN) {
  if (value === undefined || value === null) return defaultN;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return defaultN;
  return Math.min(maxN, Math.max(1, n));
}
