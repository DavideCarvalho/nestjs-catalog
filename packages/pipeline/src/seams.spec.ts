import { describe, expect, it } from 'vitest';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  CATALOG_PIPELINE_SCOPE,
  passthroughScope,
} from './seams';

describe('the injection tokens', () => {
  // Symbols rather than strings, and three distinct ones: a host binds all
  // three in the same module, and a collision would silently hand one seam the
  // provider meant for another.
  it('are distinct symbols', () => {
    const tokens = [CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY, CATALOG_PIPELINE_SCOPE];
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) expect(typeof token).toBe('symbol');
  });
});

describe('passthroughScope', () => {
  // The default for a host with a single connection, which has no scope to
  // enter. It has to be genuinely transparent: anything that swallowed a
  // rejection here would turn a failed durable step into a silent success.
  it('returns what the body returned', async () => {
    await expect(passthroughScope.run(async () => 'rows')).resolves.toBe('rows');
  });

  it('lets a failure through rather than absorbing it', async () => {
    await expect(
      passthroughScope.run(async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
  });

  it('runs the body exactly once', async () => {
    let calls = 0;
    await passthroughScope.run(async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});
