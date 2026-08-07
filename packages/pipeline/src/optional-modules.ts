/**
 * Drivers a deployment brings itself.
 *
 * This package declares no runtime dependencies. Every source that needs one —
 * `pg`, `mysql2`, the S3 SDK, `hyparquet` — resolves it at run time through
 * here, so installing a catalog does not install a Postgres client, and a
 * deployment that reads parquet chooses its own copy of the decoder.
 *
 * Lifted out of `sources.ts` when the parquet reader moved into its own file:
 * two modules needing it would otherwise have been an import cycle between
 * them, which happens to work and is not something to leave lying around.
 */

/**
 * Import a driver only when a connector needs it.
 *
 * The error names the package, because "Cannot find module 'pg'" in a catalog
 * log tells an operator nothing about which connector caused it.
 */
export async function importOptional<T>(specifier: string, label: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    // The package, not the entry point: "mysql2/promise" is not installable and
    // neither is "@aws-sdk", so a scoped name keeps both of its segments.
    const parts = specifier.split('/');
    const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    throw new Error(
      `This deployment has no ${label} driver installed. Add "${pkg}" to the catalog service to use ${label} connectors.`,
    );
  }
}

/**
 * The same, for a driver whose absence is not by itself an error.
 *
 * The one caller is parquet decompression: a file compressed with a codec
 * hyparquet does not implement needs a companion package, and the caller wants
 * to say which codec and which file rather than repeat a generic sentence about
 * a missing module.
 */
export async function importIfPresent(specifier: string): Promise<unknown> {
  try {
    return await import(specifier);
  } catch {
    return undefined;
  }
}
