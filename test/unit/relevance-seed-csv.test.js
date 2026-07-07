import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSV = join(process.cwd(), 'db', 'data', 'com.sap.developers.ims.external-RelevanceSeedExemplars.csv');

describe('#1034 seed CSV', () => {
  it('exists with expected header (no embedding column)', () => {
    const text = readFileSync(CSV, 'utf8');
    const [header] = text.split(/\r?\n/);
    const cols = header.split(';');
    expect(cols).toContain('ID');
    expect(cols).toContain('label');
    expect(cols).toContain('text');
    expect(cols).toContain('active');
    expect(cols).toContain('note');
    // Critical: embedding must NOT be in the CSV — see MEMORY.md
    // csv-changes-wipe-editable-columns.md.
    expect(cols).not.toContain('embedding');
  });

  it('has at least 3 rows per label', () => {
    const text = readFileSync(CSV, 'utf8');
    const rows = text.split(/\r?\n/).slice(1).filter(l => l.trim());
    const labels = rows.map(r => r.split(';')[1]);
    const rel = labels.filter(l => l === 'relevant').length;
    const not = labels.filter(l => l === 'not-relevant').length;
    expect(rel).toBeGreaterThanOrEqual(3);
    expect(not).toBeGreaterThanOrEqual(3);
  });
});
