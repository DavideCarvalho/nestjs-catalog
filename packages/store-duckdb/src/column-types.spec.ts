import { describe, expect, it } from 'vitest';
import { coerce, duckDbType, normalise } from './column-types';

describe('duckDbType', () => {
  it('maps every scalar to a wide, nullable-friendly type', () => {
    expect(duckDbType('string')).toBe('VARCHAR');
    expect(duckDbType('number')).toBe('DOUBLE');
    expect(duckDbType('boolean')).toBe('BOOLEAN');
    expect(duckDbType('date')).toBe('TIMESTAMP WITH TIME ZONE');
    expect(duckDbType('uuid')).toBe('VARCHAR');
    expect(duckDbType('json')).toBe('VARCHAR');
    expect(duckDbType('unknown')).toBe('VARCHAR');
  });

  it('never produces DECIMAL', () => {
    // hyparquet-writer 0.16.8 writes wrong min/max statistics for DECIMAL
    // (hyparquet-writer#38, open), and a reader that prunes row groups on
    // statistics then returns no rows for a value the file contains. Nothing
    // in this mapping may reach that type.
    const produced = (['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'] as const)
      .map(duckDbType)
      .join(' ');
    expect(produced).not.toMatch(/DECIMAL/i);
  });
});

describe('coerce', () => {
  it('serialises json to text, because a nullable JSON column loses data through the writer', () => {
    expect(coerce({ a: 1 }, 'json')).toBe('{"a":1}');
  });

  it('renders a date as an ISO instant so the engine parses one thing', () => {
    expect(coerce(new Date('2026-01-02T03:04:05.000Z'), 'date')).toBe('2026-01-02T03:04:05.000Z');
    expect(coerce('2026-01-02T03:04:05.000Z', 'date')).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes null and undefined through as null, which is what nobody-sent-it means', () => {
    expect(coerce(null, 'string')).toBeNull();
    expect(coerce(undefined, 'number')).toBeNull();
  });

  it('refuses a number it cannot represent rather than storing NaN', () => {
    expect(coerce('not a number', 'number')).toBeNull();
  });

  it('reads a textual boolean the way the source meant it', () => {
    // A CSV has no boolean type, so "false" arrives as text — and Boolean("false")
    // is true, which would invert every false this store ever loaded.
    expect(coerce('false', 'boolean')).toBe(false);
    expect(coerce('0', 'boolean')).toBe(false);
    expect(coerce('', 'boolean')).toBe(false);
    expect(coerce('true', 'boolean')).toBe(true);
    expect(coerce(0, 'boolean')).toBe(false);
    expect(coerce(1, 'boolean')).toBe(true);
  });
});

describe('normalise', () => {
  it('hands a date back as an ISO string, so two adapters agree on one rendering', () => {
    expect(normalise(new Date('2026-01-02T03:04:05.000Z'), 'date')).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('converts a bigint to a number, because JSON.stringify throws on one', () => {
    expect(normalise(42n, 'number')).toBe(42);
  });
});
