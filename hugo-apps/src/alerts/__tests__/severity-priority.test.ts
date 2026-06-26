import { describe, it, expect } from 'vitest';
import { severityToPriority } from '../severity-priority';

describe('severityToPriority', () => {
  it('maps Error → High',       () => expect(severityToPriority('Error')).toBe('High'));
  it('maps Warning → Medium',   () => expect(severityToPriority('Warning')).toBe('Medium'));
  it('maps Success → Low',      () => expect(severityToPriority('Success')).toBe('Low'));
  it('maps Information → None', () => expect(severityToPriority('Information')).toBe('None'));
});
