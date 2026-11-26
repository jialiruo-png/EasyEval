/**
 * 运行索引接口测试夹具：用内存版 RunIndex 包装成 RunIndexAccessor，
 * 与 PG 适配层共用同一份领域规则；测试不连接数据库、不启动 Docker。
 */
import { ResourceCatalog } from '../domain/resources.ts';
import {
  InMemoryRunStore, RunIndex,
  type RequestRunInput, type RunRecord, type SampleStatus,
} from '../domain/runs.ts';
import type { RunIndexAccessor, RunRequest } from './handlers.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';

export const A = 'acct-A';
export const B = 'acct-B';
export const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
export const DATASET = { id: 'ds-support', version: 'v3' } as const;
export const RULE = { id: 'rule_process_quality', version: 'v1' } as const;
export const TASK = { id: 'task-regression', version: 'v1' } as const;

export const NOW = () => '2026-11-26T10:00:00+08:00';

export interface Fixture {
  catalog: ResourceCatalog;
  store: InMemoryRunStore;
  runs: RunIndex;
  accessor: RunIndexAccessor;
}

export function setup(rowIds: string[] = ['R1', 'R2', 'R3']): Fixture {
  let tick = 0;
  const now = () => `2026-11-26T10:${String(tick++).padStart(2, '0')}:00+08:00`;
  const catalog = new ResourceCatalog(NOW);
  catalog.putScenario(A, SCENARIO, {
    name: 'DeepSeek Harness', profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A', toolWhitelist: ['read_file'],
  });
  catalog.putDataset(A, DATASET, {
    name: '客服样本集', source: 'excel', columns: ['query', 'answer'],
    rowIds, rowCount: rowIds.length, queryColumn: 'query', contentChecksum: 'sha256:abc123',
  });
  catalog.putRule(A, RULE, processQualityRule);
  const created = catalog.createTaskConfig(A, TASK, {
    name: '过程质量回归评测',
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [{ placeholder: '{{query}}', source: 'dataset', path: 'query' }],
  });
  if (!created.ok) throw new Error('fixture task creation failed: ' + JSON.stringify(created.issues));

  catalog.putScenario(B, { id: 'sc-harness-b', version: 'v1' }, {
    name: 'Harness B', profile: 'deepseek-harness', modelConfigRef: 'model-profile-B', toolWhitelist: [],
  });
  catalog.putDataset(B, { id: 'ds-support-b', version: 'v3' }, {
    name: 'B 样本集', source: 'csv', columns: ['query'], rowIds: ['R1'], rowCount: 1,
    queryColumn: 'query', contentChecksum: 'sha256:def456',
  });
  catalog.putRule(B, { id: 'rule-b', version: 'v1' }, { ...processQualityRule, id: 'rule-b' });
  catalog.createTaskConfig(B, { id: 'task-b', version: 'v1' }, {
    name: 'B 任务',
    scenario: { id: 'sc-harness-b', version: 'v1' },
    dataset: { id: 'ds-support-b', version: 'v3' },
    rule: { id: 'rule-b', version: 'v1' },
    schedule: { enabled: false, timezone: 'Asia/Shanghai' },
    variableMappings: [],
  });

  const store = new InMemoryRunStore();
  const runs = new RunIndex(catalog, { store, now });
  const accessor: RunIndexAccessor = {
    requestRun: (owner, input: RunRequest) => runs.requestRun({ ...input, ownerAccountId: owner }),
    cancelRun: (runId, owner) => runs.cancelRun(runId, owner),
    getRun: (runId, owner) => runs.getRun(runId, owner),
    listRuns: (owner) => runs.listRuns(owner),
    listRunsForTask: (owner, taskId) => runs.listRunsForTask(owner, taskId),
  };
  return { catalog, store, runs, accessor };
}

export function triggerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: { ...TASK },
    binding: { scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE } },
    requestId: 'manual-1',
    ...overrides,
  };
}

export function createRun(fixture: Fixture, overrides: Partial<RequestRunInput> = {}): RunRecord {
  const result = fixture.runs.requestRun({
    ownerAccountId: A, task: { ...TASK },
    binding: { scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE } },
    trigger: 'manual', requestId: 'seed-' + Math.random().toString(36).slice(2),
    ...overrides,
  });
  if (!result.ok || result.skipped || !result.run) throw new Error('seed run failed: ' + JSON.stringify(result));
  return result.run;
}

/** 把一个样本按合法状态路径推进到 succeeded。 */
export function completeSample(
  fixture: Fixture, run: RunRecord, sampleId: string, owner = A,
): void {
  fixture.runs.transitionRun(run.id, owner, 'running');
  const path: SampleStatus[] = ['agent_running', 'waiting_trace', 'waiting_scoring', 'succeeded'];
  for (const next of path) {
    const result = fixture.runs.setSampleStatus(run.id, owner, sampleId, next);
    if (!result.ok) throw new Error(`sample ${sampleId} -> ${next} failed: ` + JSON.stringify(result.issues));
  }
}
