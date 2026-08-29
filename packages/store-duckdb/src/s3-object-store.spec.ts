import { describe, expect, it } from 'vitest';
import { assertDeleteSucceeded } from './s3-object-store';

/**
 * The one answer from S3 that is a failure without being an exception.
 *
 * Everything else this binding sends either succeeds or throws, so it is covered by the MinIO
 * fixture simply by running. `DeleteObjectsCommand` answers `200 OK` with a per-key `Errors`
 * array and the SDK returns normally, which no container test can provoke without a second IAM
 * identity and a bucket policy — so the check itself is a function, and this is where it is
 * held to what its docblock promises.
 */
describe('assertDeleteSucceeded', () => {
  it('says nothing when every key went', () => {
    expect(() => assertDeleteSucceeded(undefined, 'catalog')).not.toThrow();
    expect(() => assertDeleteSucceeded([], 'catalog')).not.toThrow();
  });

  it('throws naming the keys and their codes, because the code decides the repair', () => {
    // AccessDenied is a policy to widen; a throttle is a retry. A refusal that named neither
    // would send an operator looking at this package instead of at the bucket.
    expect(() =>
      assertDeleteSucceeded(
        [
          { Key: 'mvr/run-1/part-000000.parquet', Code: 'AccessDenied' },
          { Key: 'mvr/run-1/part-000001.parquet', Code: 'InternalError' },
        ],
        'catalog',
      ),
    ).toThrow(/2 object\(s\) under catalog.*part-000000\.parquet \(AccessDenied\)/s);
  });

  it('summarises past the first few rather than printing a thousand keys', () => {
    const errors = Array.from({ length: 10 }, (_unused, index) => ({
      Key: `mvr/run-1/part-${String(index).padStart(6, '0')}.parquet`,
      Code: 'AccessDenied',
    }));
    expect(() => assertDeleteSucceeded(errors, 'catalog')).toThrow(/and 7 more/);
  });

  it('still names the count when S3 reports an error with no key or code', () => {
    expect(() => assertDeleteSucceeded([{}], 'catalog')).toThrow(/<unnamed> \(no code\)/);
  });
});
