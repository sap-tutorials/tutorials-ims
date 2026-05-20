import { parse as csvParse } from 'csv-parse/sync';

export const MAX_ROWS = 5000;
export const MAX_BYTES = 1_000_000;
const MAX_FIELD_LEN = 255;

export function parsePayload(payload, format) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('Empty payload');
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
    throw new Error(`Payload exceeds ${MAX_BYTES} bytes`);
  }

  let raw;
  if (format === 'csv') raw = parseCsv(payload);
  else if (format === 'json') raw = parseJson(payload);
  else throw new Error(`Unsupported format: ${format}`);

  if (raw.length > MAX_ROWS) {
    throw new Error(`Too many rows: ${raw.length} > ${MAX_ROWS}`);
  }

  return classifyRows(raw, format === 'json');
}

function parseCsv(payload) {
  const stripped = payload.replace(/^﻿/, '');
  let records;
  try {
    records = csvParse(stripped, {
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: false
    });
  } catch (err) {
    throw new Error(`Malformed CSV: ${err.message}`);
  }
  if (records.length === 0) {
    throw new Error('CSV must contain a header row and at least one data row');
  }
  const cols = Object.keys(records[0]);
  for (const required of ['name', 'titlePath']) {
    if (!cols.includes(required)) {
      throw new Error(`Missing required header: ${required}`);
    }
  }
  return records;
}

function parseJson(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  if (!Array.isArray(parsed)) throw new Error('JSON payload must be an array');
  return parsed;
}

function classifyRows(raw, isJson = false) {
  const rows = [];
  const parseErrors = [];
  const seen = new Map();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];

    if (isJson) {
      if (typeof r.name !== 'string') {
        rows.push({ invalid: true, name: r.name, titlePath: r.titlePath, reason: 'name must be a string' });
        continue;
      }
      if (typeof r.titlePath !== 'string') {
        rows.push({ invalid: true, name: r.name, titlePath: r.titlePath, reason: 'titlePath must be a string' });
        continue;
      }
    }

    const name = (r.name ?? '').toString().trim();
    const titlePath = (r.titlePath ?? '').toString().trim();

    if (!name) {
      rows.push({ invalid: true, name, titlePath, reason: 'missing required field: name' });
      continue;
    }
    if (!titlePath) {
      rows.push({ invalid: true, name, titlePath, reason: 'missing required field: titlePath' });
      continue;
    }
    if (name.length > MAX_FIELD_LEN || titlePath.length > MAX_FIELD_LEN) {
      rows.push({ invalid: true, name, titlePath, reason: 'field exceeds 255 chars' });
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      parseErrors.push({
        line: i + 2,
        name,
        reason: `duplicate of row ${seen.get(key) + 2} (case-insensitive)`
      });
      continue;
    }
    seen.set(key, i);
    rows.push({ name, titlePath });
  }

  return { rows, parseErrors };
}
