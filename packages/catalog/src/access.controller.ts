import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotImplementedException,
  Optional,
  Post,
  Query,
  type Type,
  UseGuards,
} from '@nestjs/common';
import {
  CATALOG_DIRECTORY,
  CATALOG_DIRECTORY_MAX_PAGE,
  CATALOG_DIRECTORY_PAGE,
  type CatalogDirectory,
  type CatalogPersonInput,
  type CatalogPersonRole,
} from './catalog.access';
import { RequireScopes } from './catalog.route-auth';

const ROLES: readonly CatalogPersonRole[] = ['viewer', 'curator', 'administrator'];

function isRole(value: unknown): value is CatalogPersonRole {
  return typeof value === 'string' && ROLES.some((role) => role === value);
}

/**
 * The Access screen's endpoints.
 *
 * A factory for the same reason as `createCatalogController`: the prefix and
 * the guards come from `forRoot`, and this surface enumerates every application
 * that can write to the catalog, which is not something to hand a library's
 * default opinion about auth.
 */
export function createAccessController(
  path: string,
  guards: Type<unknown>[],
  decorators: ClassDecorator[] = [],
): Type<unknown> {
  @Controller(path)
  class AccessController {
    constructor(
      // Optional so that a host which mounts the catalog without wiring a
      // directory gets a catalog that works in every other respect and one
      // screen that says why — the same shape as `CATALOG_TRACE_STORE`.
      @Optional()
      @Inject(CATALOG_DIRECTORY)
      private readonly directory?: CatalogDirectory,
    ) {}

    private require(): CatalogDirectory {
      if (!this.directory) {
        throw new NotImplementedException(
          'This catalog has no directory, so it cannot say who may reach it. ' +
            'Provide CATALOG_DIRECTORY — `CatalogMikroOrmStoreModule` ships one that reads `catalog_principal`.',
        );
      }
      return this.directory;
    }

    /**
     * Every route here is `catalog:admin`, and the screen is the reason.
     *
     * `listApplications` enumerates each application that can reach the catalog
     * together with its scopes, its `writeTypes` and its `classifications` —
     * which is to say, the map of what a stolen credential would be worth and
     * which one to steal. `upsertPerson` writes into the host's directory and
     * accepts `role: 'administrator'`, so an unscoped POST here is a way to
     * grant yourself the scope this endpoint is protecting.
     *
     * Nothing weaker fits: `catalog:curate` is documented as editing labels and
     * units, and reading who may write to the catalog is not a curation act.
     * The console already hides this screen behind `catalog:admin`; until now
     * that client-side check was the ONLY check, and a hidden tab is not an
     * access control — anybody authenticated could call these three paths
     * directly. `catalog.route-auth.ts` is explicit that a route declaring no
     * scope means "authenticated is enough", so the absence was not an
     * oversight the framework would catch. It is caught now: the completeness
     * sweep in `catalog.route-scopes.integration.spec.ts` reads THIS factory
     * too, which is what let these three escape it in the first place.
     */
    @Get('principals')
    @RequireScopes('catalog:admin')
    principals() {
      return this.require().listApplications();
    }

    @Get('people')
    @RequireScopes('catalog:admin')
    people(
      @Query('search') search?: string,
      @Query('limit') limit?: string,
      @Query('offset') offset?: string,
    ) {
      const directory = this.require();
      if (!directory.listPeople) {
        // 501, not 200-with-nothing. The screen renders a failed read and an
        // empty list very differently on purpose, and this is genuinely the
        // first: the people exist, they are just not ours to enumerate.
        throw new NotImplementedException(
          "People come from this application's own identity system, not from the catalog. " +
            'Implement `listPeople` on CATALOG_DIRECTORY to list them here.',
        );
      }
      // Bounded HERE, not left to each implementation. A host's user table is
      // its whole directory, and the seam would otherwise invite exactly the
      // unbounded read this endpoint would then serve to a browser.
      return directory.listPeople({
        ...(search ? { search } : {}),
        limit: boundedPage(limit),
        offset: nonNegative(offset),
      });
    }

    @Post('people')
    @RequireScopes('catalog:admin')
    upsertPerson(@Body() body: unknown) {
      const directory = this.require();
      if (!directory.upsertPerson) {
        throw new NotImplementedException(
          "This catalog's directory is read-only. Add or change people where they actually live; " +
            'implement `upsertPerson` on CATALOG_DIRECTORY only if that is here.',
        );
      }
      return directory.upsertPerson(parsePersonInput(body));
    }
  }

  if (guards.length > 0) UseGuards(...guards)(AccessController);
  for (const decorate of decorators) decorate(AccessController);

  return AccessController;
}

/**
 * A page size that cannot be talked out of its ceiling.
 *
 * Anything unparseable falls back to the default rather than to "no limit" —
 * `?limit=all` must not be the one string that turns the bound off.
 */
function boundedPage(raw: string | undefined): number {
  const asked = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(asked) || asked <= 0) return CATALOG_DIRECTORY_PAGE;
  return Math.min(asked, CATALOG_DIRECTORY_MAX_PAGE);
}

function nonNegative(raw: string | undefined): number {
  const asked = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(asked) && asked > 0 ? asked : 0;
}

/**
 * Validated here rather than with a DTO class, because this package ships no
 * `class-validator` dependency and a host's global `ValidationPipe` is not
 * something a library can assume is mounted.
 */
function parsePersonInput(body: unknown): CatalogPersonInput {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('Expected an object describing the person.');
  }
  const email = Reflect.get(body, 'email');
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new BadRequestException('`email` is required and must be an email address.');
  }
  const role = Reflect.get(body, 'role');
  if (!isRole(role)) {
    throw new BadRequestException(`\`role\` must be one of: ${ROLES.join(', ')}.`);
  }
  const displayName = Reflect.get(body, 'displayName');
  const active = Reflect.get(body, 'active');
  const password = Reflect.get(body, 'password');
  return {
    email,
    role,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof active === 'boolean' ? { active } : {}),
    ...(typeof password === 'string' ? { password } : {}),
  };
}
