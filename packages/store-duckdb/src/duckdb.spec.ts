import { describe, expect, it } from 'vitest';
import { quoteLiteral } from './duckdb';

describe('quoteLiteral', () => {
  it('doubles an embedded quote, so a path with one cannot end the string', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  });

  it('leaves an ordinary path alone but wraps it', () => {
    expect(quoteLiteral('s3://bucket/prefix/mvr/run-1/*.parquet')).toBe(
      "'s3://bucket/prefix/mvr/run-1/*.parquet'",
    );
  });
});
