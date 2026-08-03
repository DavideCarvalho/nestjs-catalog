import { type CatalogPrincipal, RequireScopes } from '@dudousxd/nestjs-catalog';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { PublishService, type PublishedType } from './publish.service';

/**
 * How an application publishes into the catalog.
 *
 * Three calls, in order, mirroring what the store can promise:
 *
 *   PUT  /api/catalog-service/publish/:type/schema
 *   POST /api/catalog-service/publish/:type/snapshots/:snapshot/rows
 *   POST /api/catalog-service/publish/:type/snapshots/:snapshot/commit
 *
 * Splitting append from commit is what makes a load atomic from a reader's
 * point of view. A publisher that dies halfway leaves rows nobody can see
 * rather than a table that is quietly half-loaded, and the difference between
 * those two only matters once — which is the once that counts.
 *
 * The snapshot id is chosen by the caller, not by us. Passing something the
 * caller already has that identifies the load — a durable run id, an import
 * durable run id — makes a retried batch land in the same snapshot instead of
 * creating a second one.
 */
export function createPublishController(path: string, guards: Type<unknown>[] = []): Type<unknown> {
  // No `api/` prefix: a host's global prefix, if it sets one, applies on top.
  @Controller(`${path}/publish`)
  @RequireScopes('catalog:write')
  class PublishController {
    constructor(private readonly publish: PublishService) {}

    @Put(':type/schema')
    async schema(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('type') type: string,
      @Body() body: PublishedType,
    ) {
      const principal = requirePrincipal(request);
      if (body?.name && body.name !== type) {
        throw new BadRequestException(
          `Body names type "${body.name}" but the path says "${type}".`,
        );
      }
      return this.publish.upsertType(principal, { ...body, name: type });
    }

    @Post(':type/snapshots/:snapshot/rows')
    async rows(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('type') type: string,
      @Param('snapshot') snapshot: string,
      @Body()
      body: {
        rows: Array<Record<string, unknown>>;
        labels?: Record<string, string>;
        /**
         * Which batch of this load. Send it, and a retry replaces the batch
         * instead of appending a second copy — the whole reason the publisher
         * chooses the snapshot id rather than being handed one.
         */
        batch?: number;
      },
    ) {
      const principal = requirePrincipal(request);
      return this.publish.appendRows(
        principal,
        type,
        snapshot,
        body?.rows ?? [],
        body?.labels,
        body?.batch,
      );
    }

    @Post(':type/snapshots/:snapshot/commit')
    async commit(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('type') type: string,
      @Param('snapshot') snapshot: string,
    ) {
      const principal = requirePrincipal(request);
      return this.publish.commit(principal, type, snapshot);
    }

    /** Provenance: every load of this type, who wrote it and when. */
    @Get(':type/snapshots')
    async snapshots(@Param('type') type: string) {
      return this.publish.listSnapshots(type);
    }
  }

  if (guards.length > 0) {
    UseGuards(...guards)(PublishController);
  }

  return PublishController;
}

function requirePrincipal(request: {
  principal?: CatalogPrincipal;
}): CatalogPrincipal {
  if (!request.principal) {
    // The guard sets this on every route it protects, so reaching here means
    // the guard was removed rather than that a caller did something clever.
    throw new Error('CatalogPrincipalGuard did not run on a route that requires it.');
  }
  return request.principal;
}
