/**
 * 草稿接口测试夹具：用内存 DraftManager 包装成 DraftAccessor，
 * 与 PG 适配层共用同一份领域规则；测试不连接数据库、不启动 Docker。
 */
import {
  DraftManager, InMemoryDraftStore, InMemoryPreviewStore,
  type ConfirmDraftInput, type CreateDraftInput, type DraftRecord, type UpdateDraftInput,
} from '../domain/drafts.ts';
import { ResourceCatalog, type VariableMapping } from '../domain/resources.ts';
import { processQualityRule } from '../result-contract/fixtures.ts';
import type { DraftAccessor } from './handlers.ts';

export const A = 'acct-A';
export const B = 'acct-B';
export const SCENARIO = { id: 'sc-harness', version: 'v1' } as const;
export const DATASET = { id: 'ds-support', version: 'v1' } as const;
export const RULE = { id: 'rule-process_quality', version: 'v1' } as const;
export const MAPPINGS: VariableMapping[] = [
  { placeholder: '{{query}}', source: 'dataset', path: 'query' },
  { placeholder: '{{answer}}', source: 'agent', path: 'final_answer' },
];

export interface Fixture {
  catalog: ResourceCatalog;
  drafts: DraftManager;
  accessor: DraftAccessor;
}

export function setup(): Fixture {
  const catalog = new ResourceCatalog(() => '2026-11-26T10:00:00+08:00');
  catalog.putScenario(A, SCENARIO, {
    name: 'DeepSeek Harness', profile: 'deepseek-harness',
    modelConfigRef: 'model-profile-A', toolWhitelist: ['read_file'],
  });
  catalog.putDataset(A, DATASET, {
    name: '客服样本集', source: 'excel', columns: ['query', 'answer'],
    rowIds: ['R1', 'R2', 'R3'], rowCount: 3, queryColumn: 'query', contentChecksum: 'sha256:abc',
  });
  catalog.putRule(A, RULE, processQualityRule);

  catalog.putScenario(B, { id: 'sc-harness-b', version: 'v1' }, {
    name: 'Harness B', profile: 'deepseek-harness', modelConfigRef: 'model-profile-B', toolWhitelist: [],
  });
  catalog.putDataset(B, { id: 'ds-support-b', version: 'v1' }, {
    name: 'B 样本集', source: 'csv', columns: ['query'], rowIds: ['R1'], rowCount: 1,
    queryColumn: 'query', contentChecksum: 'sha256:def',
  });
  catalog.putRule(B, { id: 'rule-b', version: 'v1' }, { ...processQualityRule, id: 'rule-b' });

  const drafts = new DraftManager(catalog, {
    store: new InMemoryDraftStore(), previewStore: new InMemoryPreviewStore(),
    now: () => '2026-11-26T10:00:00+08:00',
  });
  const accessor: DraftAccessor = {
    async create(owner, input) { return drafts.create({ ...input, ownerAccountId: owner! }); },
    async get(owner, id) { return drafts.get(owner, id); },
    async list(owner) { return drafts.list(owner); },
    async update(owner, id, input: UpdateDraftInput) { return drafts.update(owner, id, input); },
    async cancel(owner, id) { return drafts.cancel(owner, id); },
    async confirm(owner, id, input: ConfirmDraftInput) { return drafts.confirm(owner, id, input); },
    async acquirePreview(owner, id, sampleId) { return drafts.acquirePreview(owner, id, sampleId); },
    async markPreview(owner, id, sampleId, status, detail) {
      return drafts.markPreview(owner, id, sampleId, status, detail);
    },
    async retryPreview(owner, id, sampleId) { return drafts.retryPreview(owner, id, sampleId); },
    async listPreviews(owner, id) { return drafts.listPreviews(owner, id); },
  };
  return { catalog, drafts, accessor };
}

export function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'draft:regression-1', name: '过程质量回归草稿', step: 2,
    scenario: { ...SCENARIO }, dataset: { ...DATASET }, rule: { ...RULE },
    mappings: MAPPINGS.map((mapping) => ({ ...mapping })),
    ...overrides,
  };
}

export function confirmBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskRef: { id: 'task-regression', version: 'v1' },
    name: '过程质量回归评测', idempotencyKey: 'confirm-1', expectedRevision: 1,
    ...overrides,
  };
}

/** 创建一个已确认草稿之前的标准活跃草稿。 */
export async function seedDraft(
  accessor: DraftAccessor, owner = A, overrides: Record<string, unknown> = {},
): Promise<DraftRecord> {
  const result = await accessor.create(owner, createBody(overrides) as Omit<CreateDraftInput, 'ownerAccountId'>);
  if (!result.ok) throw new Error('seed draft failed: ' + JSON.stringify(result.issues));
  return result.value;
}
