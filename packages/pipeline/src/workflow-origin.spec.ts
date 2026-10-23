import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { DurableModule } from '@dudousxd/nestjs-durable';
import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ConnectorRunSteps } from './connector-run.steps';
import { CONNECTOR_RUN_WORKFLOW, ConnectorRunWorkflow } from './connector-run.workflow';
import { WorkflowRunSteps } from './workflow-run.steps';
import { CATALOG_WORKFLOW_RUN, CatalogWorkflowRunWorkflow } from './workflow-run.workflow';
import { WorkflowRunnerService } from './workflow-runner.service';

/**
 * The durable console groups runs by `origin`: the npm package that declared the workflow. Neither
 * catalog workflow passes one. `@dudousxd/nestjs-durable` (>= 0.40.0) derives it from the
 * `@Workflow` class's declaring file, which resolves to this package's `package.json`. This boots the
 * real durable module (no `vi.mock`) and checks that a started run carries this package's name and
 * not the host app's.
 *
 * Only run creation matters here. The steps are empty stand-ins, so the body fails right after the
 * run is recorded, which is after the origin was stamped.
 */
const PACKAGE_NAME: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).name;

describe('catalog workflow runs carry the pipeline package as their origin', () => {
  it.each([
    [CONNECTOR_RUN_WORKFLOW, { connectorId: 'c-1', principalId: 'p-1' }],
    [CATALOG_WORKFLOW_RUN, { connectorId: 'c-1', workflowId: 'wf-1', workflowVersion: 1 }],
  ])('%s', async (workflow, input) => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport() })],
      providers: [
        ConnectorRunWorkflow,
        CatalogWorkflowRunWorkflow,
        { provide: ConnectorRunSteps, useValue: {} },
        { provide: WorkflowRunSteps, useValue: {} },
        { provide: WorkflowRunnerService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    try {
      await moduleRef.get(WorkflowEngine).start(workflow, input, 'r-origin');

      expect(PACKAGE_NAME).toBe('@dudousxd/nestjs-catalog-pipeline');
      expect((await store.getRun('r-origin'))?.origin).toBe(PACKAGE_NAME);
    } finally {
      await moduleRef.close();
    }
  });
});
