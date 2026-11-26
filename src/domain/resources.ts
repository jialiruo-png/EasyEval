/**
 * P2 版本化资源领域契约（P1 阻塞期可准备工作）。
 *
 * 把 plan.md P2「场景配置、数据集版本、规则版本、任务配置、运行索引」与
 * readme.md「创建人取登录账号、读取修改同时限定账号和资源 ID」固化为可执行逻辑：
 *  - 每个资源是带所有者的不可变版本；内容由稳定哈希标识，重复写入同内容幂等，改内容被拒绝。
 *  - 读取按账号限定；越权与不存在一律表现为 undefined，供上层统一为 404。
 *  - 任务配置写入时校验场景／数据集／规则三个引用存在、归属同一账号，并把绑定冻结为快照。
 *  - 运行索引写入前再校验一次：运行声明的版本必须与任务已冻结的绑定一致且仍属同一账号。
 *  - 归档按冻结版本标记状态，不删除版本、单元格或历史运行；被未归档任务引用的数据集／规则
 *    拒绝归档，归档后的数据集／规则不能新建绑定，归档任务不能发起新运行，详情仍可读。
 *
 * 仅用 Node 22 内置 node:crypto / structuredClone；不访问 Docker、网络、上游或模型。
 */
import type { DatasetRowStore } from './dataset-rows.ts';
import { createHash } from 'node:crypto';
import { validateRuleDefinition, type RuleDef } from '../result-contract/contract.ts';

export class ImmutableVersionConflict extends Error {}

export type DatasetSource = 'excel' | 'csv' | 'feishu' | 'sql';

/** 版本引用：稳定 ID + 不可变版本号，二者共同定位一份冻结快照。 */
export interface VersionRef {
  id: string;
  version: string;
}

export interface ScenarioConfigSnapshot {
  name: string;
  /** SDK profile 标识，例如 deepseek-harness */
  profile: string;
  modelConfigRef: string;
  toolWhitelist: string[];
}

export interface DatasetSnapshot {
  name: string;
  source: DatasetSource;
  columns: string[];
  /** 冻结的行 ID 与行顺序 */
  rowIds: string[];
  rowCount: number;
  queryColumn: string;
  contentChecksum: string;
}

export interface VariableMapping {
  placeholder: string;
  source: string;
  path: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  cron?: string;
  timezone: 'Asia/Shanghai';
}

export function validateSchedule(value: unknown, field = 'schedule') {
  const schedule = value as Partial<ScheduleConfig> | null;
  const invalid = (path: string, message: string) => ({ code: 'INVALID_INPUT' as const, field: path, message });
  if (schedule?.timezone !== 'Asia/Shanghai') return invalid(field, '时区必须为 Asia/Shanghai');
  if (typeof schedule.enabled !== 'boolean') return invalid(field + '.enabled', '定时开关必须是布尔值');
  if (schedule.enabled && (typeof schedule.cron !== 'string' || !schedule.cron.trim())) {
    return invalid(field + '.cron', '启用定时必须提供 cron');
  }
}

export interface TaskBinding {
  /** 新任务必填。早期已冻结的快照可能没有名称。 */
  name?: string;
  scenario: VersionRef;
  dataset: VersionRef;
  rule: VersionRef;
  schedule: ScheduleConfig;
  variableMappings: VariableMapping[];
}

/** 一份不可变资源版本记录；createdAt 由调用方注入时钟，便于确定性测试。 */
export interface ResourceVersion<T> {
  readonly ownerAccountId: string;
  readonly ref: Readonly<VersionRef>;
  readonly snapshot: T;
  readonly contentHash: string;
  readonly createdAt: string;
}

/** 键顺序无关的序列化，保证同一业务内容得到同一哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function resourceContentHash(ownerAccountId: string, ref: VersionRef, snapshot: unknown): string {
  return createHash('sha256').update(stableStringify({ ownerAccountId, ref, snapshot }), 'utf8').digest('hex');
}

/** 存储实现从磁盘还原快照时同样深冻结，保证内存与落盘两种实现的读取语义一致。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function requireText(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
}

function requireRef(ref: VersionRef, label: string): void {
  requireText(ref?.id, `${label} id`);
  requireText(ref?.version, `${label} version`);
}

function versionKey(ref: VersionRef): string {
  return `${encodeURIComponent(ref.id)}@${encodeURIComponent(ref.version)}`;
}

/**
 * 版本存储接口：内存与 SQLite 两种实现共用同一份写入幂等、不可变与归属读取语义。
 * ResourceCatalog 的绑定校验只依赖此接口，避免落盘后口径分叉。
 */
export interface VersionStore<T> {
  put(ownerAccountId: string, ref: VersionRef, snapshot: T, now: () => string): ResourceVersion<T>;
  peek(ref: VersionRef): ResourceVersion<T> | undefined;
  get(ref: VersionRef, accountId: string | undefined): ResourceVersion<T> | undefined;
  list(accountId: string | undefined): ResourceVersion<T>[];
}

/** 通用版本表：同键同内容幂等，同键不同内容拒绝；读取按账号限定。 */
export class VersionTable<T> implements VersionStore<T> {
  private readonly byKey = new Map<string, ResourceVersion<T>>();

  constructor(records: readonly ResourceVersion<T>[] = []) {
    for (const record of records) this.byKey.set(versionKey(record.ref), deepFreeze(record));
  }

  put(
    ownerAccountId: string,
    ref: VersionRef,
    snapshot: T,
    now: () => string,
  ): ResourceVersion<T> {
    requireText(ownerAccountId, 'ownerAccountId');
    requireRef(ref, '版本引用');
    const frozen = deepFreeze(structuredClone(snapshot));
    const hash = resourceContentHash(ownerAccountId, ref, frozen);
    const key = versionKey(ref);
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.contentHash !== hash || existing.ownerAccountId !== ownerAccountId) {
        throw new ImmutableVersionConflict(`版本 ${key} 已存在且内容不可变`);
      }
      return existing;
    }
    const record: ResourceVersion<T> = Object.freeze({
      ownerAccountId,
      ref: Object.freeze({ ...ref }),
      snapshot: frozen,
      contentHash: hash,
      createdAt: now(),
    });
    this.byKey.set(key, record);
    return record;
  }

  peek(ref: VersionRef): ResourceVersion<T> | undefined {
    return this.byKey.get(versionKey(ref));
  }

  get(ref: VersionRef, accountId: string | undefined): ResourceVersion<T> | undefined {
    if (!accountId) return undefined;
    const record = this.peek(ref);
    return record && record.ownerAccountId === accountId ? record : undefined;
  }

  list(accountId: string | undefined): ResourceVersion<T>[] {
    if (!accountId) return [];
    return [...this.byKey.values()].filter((record) => record.ownerAccountId === accountId);
  }
}

/** 内存归档状态表：同键同归属幂等，换归属拒绝，读取按账号限定。 */
export class InMemoryArchiveStore implements ArchiveStore {
  private readonly byKey = new Map<string, ArchivedResource>();

  put(
    ownerAccountId: string,
    kind: ArchivableResourceKind,
    ref: VersionRef,
    now: () => string,
  ): ArchivedResource {
    requireText(ownerAccountId, 'ownerAccountId');
    requireRef(ref, '版本引用');
    const key = `${kind} ${versionKey(ref)}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.ownerAccountId !== ownerAccountId) {
        throw new ImmutableVersionConflict(`归档记录 ${key} 归属不可变`);
      }
      return existing;
    }
    const record = deepFreeze({
      ownerAccountId,
      kind,
      ref: { ...ref },
      archivedAt: now(),
    } as ArchivedResource);
    this.byKey.set(key, record);
    return record;
  }

  get(kind: ArchivableResourceKind, ref: VersionRef, accountId: string | undefined): ArchivedResource | undefined {
    if (!accountId) return undefined;
    const record = this.byKey.get(`${kind} ${versionKey(ref)}`);
    return record?.ownerAccountId === accountId ? record : undefined;
  }

  list(kind: ArchivableResourceKind, accountId: string | undefined): ArchivedResource[] {
    if (!accountId) return [];
    return deepFreeze(
      [...this.byKey.values()].filter((record) => record.kind === kind && record.ownerAccountId === accountId),
    );
  }
}

function validateScenario(snapshot: ScenarioConfigSnapshot): void {
  requireText(snapshot.name, '场景名称');
  requireText(snapshot.profile, '场景 profile');
  requireText(snapshot.modelConfigRef, '模型配置引用');
  if (!Array.isArray(snapshot.toolWhitelist) || snapshot.toolWhitelist.some((tool) => typeof tool !== 'string' || !tool.trim())) throw new Error('工具白名单必须是工具名称数组');
}

function validateDataset(snapshot: DatasetSnapshot): void {
  requireText(snapshot.name, '数据集名称');
  if (!['excel', 'csv', 'feishu', 'sql'].includes(snapshot.source)) throw new Error('不支持的数据集来源');
  if (!Array.isArray(snapshot.columns) || snapshot.columns.length === 0) {
    throw new Error('数据集列不能为空');
  }
  snapshot.columns.forEach((column) => requireText(column, '列名'));
  if (new Set(snapshot.columns).size !== snapshot.columns.length) throw new Error('数据集列重复');
  if (!snapshot.columns.includes(snapshot.queryColumn)) {
    throw new Error('查询列不在数据集列中');
  }
  if (!Array.isArray(snapshot.rowIds)) throw new Error('行 ID 列表必须是数组');
  snapshot.rowIds.forEach((id) => requireText(id, '行 ID'));
  if (new Set(snapshot.rowIds).size !== snapshot.rowIds.length) throw new Error('行 ID 重复');
  if (snapshot.rowCount !== snapshot.rowIds.length) throw new Error('行数与行 ID 数量不一致');
  requireText(snapshot.contentChecksum, '内容校验值');
}

function validateRule(snapshot: RuleDef): void {
  requireText(snapshot.id, '规则 id');
  requireText(snapshot.version, '规则 version');
  validateRuleDefinition(snapshot);
}

export type ArchivableResourceKind = 'dataset' | 'rule' | 'task';

/** 归档状态记录：只标记冻结版本，不改变 ResourceVersion 内容与归属。 */
export interface ArchivedResource {
  readonly ownerAccountId: string;
  readonly kind: ArchivableResourceKind;
  readonly ref: Readonly<VersionRef>;
  readonly archivedAt: string;
}

/**
 * 归档状态存储：内存与 SQLite 共用同一份幂等、归属限定语义。
 * 归档不是删除，因此不触碰版本表与行存储；越权与不存在同样返回 undefined。
 */
export interface ArchiveStore {
  put(ownerAccountId: string, kind: ArchivableResourceKind, ref: VersionRef, now: () => string): ArchivedResource;
  get(kind: ArchivableResourceKind, ref: VersionRef, accountId: string | undefined): ArchivedResource | undefined;
  list(kind: ArchivableResourceKind, accountId: string | undefined): ArchivedResource[];
}

/** 引用某冻结版本的任务摘要，供管理页列出「谁在用」并决定是否允许归档。 */
export interface TaskReference {
  readonly ref: Readonly<VersionRef>;
  readonly name?: string;
  readonly archived: boolean;
}

export type BindingErrorCode =
  | 'INVALID_INPUT'
  | 'VERSION_CONFLICT'
  | 'SCENARIO_NOT_FOUND'
  | 'DATASET_NOT_FOUND'
  | 'RULE_NOT_FOUND'
  | 'OWNER_MISMATCH'
  | 'TASK_NOT_FOUND'
  | 'BINDING_MISMATCH'
  | 'RESOURCE_NOT_FOUND'
  | 'ACTIVE_TASK_REFERENCE'
  | 'ARCHIVE_CONFLICT'
  | 'DATASET_ARCHIVED'
  | 'RULE_ARCHIVED'
  | 'TASK_ARCHIVED';

export interface BindingIssue {
  code: BindingErrorCode;
  field: string;
  message: string;
}

export type BindingResult<T> =
  | { ok: true; value: ResourceVersion<T> }
  | { ok: false; issues: BindingIssue[] };

export type ArchiveResult =
  | { ok: true; value: ArchivedResource; replayed: boolean }
  | { ok: false; issues: BindingIssue[]; references: TaskReference[] };

function issue(code: BindingErrorCode, field: string, message: string): BindingIssue {
  return { code, field, message };
}

/** 四类资源的存储实现；省略时全部使用内存表，便于纯逻辑测试。 */
export interface ResourceStores {
  scenario: VersionStore<ScenarioConfigSnapshot>;
  dataset: VersionStore<DatasetSnapshot>;
  rule: VersionStore<RuleDef>;
  task: VersionStore<TaskBinding>;
}

export interface ResourceCatalogOptions {
  now?: () => string;
  stores?: ResourceStores;
  datasetRows?: DatasetRowStore;
  archives?: ArchiveStore;
}

/**
 * 持有四类版本资源。绑定校验、列表和详情都使用当前账号读取资源。
 */
export class ResourceCatalog {
  private readonly scenarios: VersionStore<ScenarioConfigSnapshot>;
  private readonly defaultDatasetRows?: DatasetRowStore;
  private readonly importedRowStores = new Map<string, DatasetRowStore>();
  private readonly datasets: VersionStore<DatasetSnapshot>;
  private readonly rules: VersionStore<RuleDef>;
  private readonly tasks: VersionStore<TaskBinding>;
  private readonly archives: ArchiveStore;
  private readonly now: () => string;

  constructor(options: ResourceCatalogOptions | (() => string) = {}) {
    const resolved: ResourceCatalogOptions = typeof options === 'function' ? { now: options } : options;
    this.defaultDatasetRows = resolved.datasetRows;
    this.now = resolved.now ?? (() => new Date().toISOString());
    this.scenarios = resolved.stores?.scenario ?? new VersionTable<ScenarioConfigSnapshot>();
    this.datasets = resolved.stores?.dataset ?? new VersionTable<DatasetSnapshot>();
    this.rules = resolved.stores?.rule ?? new VersionTable<RuleDef>();
    this.tasks = resolved.stores?.task ?? new VersionTable<TaskBinding>();
    this.archives = resolved.archives ?? new InMemoryArchiveStore();
  }

  datasetRowsFor(ref: VersionRef): DatasetRowStore | undefined {
    return this.importedRowStores.get(versionKey(ref)) ?? this.defaultDatasetRows;
  }

  rememberDatasetRows(ref: VersionRef, store: DatasetRowStore): void {
    if (!this.defaultDatasetRows) this.importedRowStores.set(versionKey(ref), store);
  }

  putScenario(owner: string, ref: VersionRef, snapshot: ScenarioConfigSnapshot): ResourceVersion<ScenarioConfigSnapshot> {
    validateScenario(snapshot);
    return this.scenarios.put(owner, ref, snapshot, this.now);
  }

  putDataset(owner: string, ref: VersionRef, snapshot: DatasetSnapshot): ResourceVersion<DatasetSnapshot> {
    validateDataset(snapshot);
    return this.datasets.put(owner, ref, snapshot, this.now);
  }

  putRule(owner: string, ref: VersionRef, snapshot: RuleDef): ResourceVersion<RuleDef> {
    const previous = this.rules.get(ref, owner);
    if (previous && previous.contentHash === resourceContentHash(owner, ref, snapshot)) return previous;
    requireText(snapshot.name ?? '', '规则名称');
    validateRule(snapshot);
    return this.rules.put(owner, ref, snapshot, this.now);
  }

  getScenario(ref: VersionRef, accountId: string | undefined) { return this.scenarios.get(ref, accountId); }
  getDataset(ref: VersionRef, accountId: string | undefined) { return this.datasets.get(ref, accountId); }
  getRule(ref: VersionRef, accountId: string | undefined) { return this.rules.get(ref, accountId); }
  getTask(ref: VersionRef, accountId: string | undefined) { return this.tasks.get(ref, accountId); }

  listScenarios(accountId: string | undefined) { return this.scenarios.list(accountId); }
  listDatasets(accountId: string | undefined) { return this.datasets.list(accountId); }
  listRules(accountId: string | undefined) { return this.rules.list(accountId); }
  listTasks(accountId: string | undefined) { return this.tasks.list(accountId); }

  getArchive(kind: ArchivableResourceKind, ref: VersionRef, accountId: string | undefined) {
    return this.archives.get(kind, ref, accountId);
  }

  listArchived(kind: ArchivableResourceKind, accountId: string | undefined) {
    return this.archives.list(kind, accountId);
  }

  /** 列出本人引用指定数据集／规则版本的任务；已归档任务也会返回并以 archived 标记。 */
  listReferencingTasks(kind: 'dataset' | 'rule', ref: VersionRef, accountId: string | undefined): TaskReference[] {
    if (!accountId || !ref?.id?.trim() || !ref?.version?.trim()) return [];
    return deepFreeze(this.tasks.list(accountId).filter((task) => {
      const boundRef = kind === 'dataset' ? task.snapshot.dataset : task.snapshot.rule;
      return boundRef?.id === ref.id && boundRef?.version === ref.version;
    }).map((task) => ({
      ref: { ...task.ref },
      name: task.snapshot.name,
      archived: Boolean(this.archives.get('task', task.ref, accountId)),
    })));
  }

  /**
   * 按冻结版本归档：只写状态，不删除版本、样本行或历史运行。
   * 数据集／规则被未归档任务引用时拒绝并返回引用任务；同键重放幂等。
   */
  archiveResource(kind: ArchivableResourceKind, ref: VersionRef, accountId: string): ArchiveResult {
    const references: TaskReference[] = [];
    if (!accountId?.trim() || !['dataset', 'rule', 'task'].includes(kind)) {
      return { ok: false, issues: [issue('INVALID_INPUT', 'kind', '账号与资源类型必须有效')], references };
    }
    try {
      requireRef(ref, '版本引用');
    } catch (error) {
      return { ok: false, issues: [issue('INVALID_INPUT', 'ref', (error as Error).message)], references };
    }
    const version = kind === 'dataset' ? this.datasets.get(ref, accountId)
      : kind === 'rule' ? this.rules.get(ref, accountId)
        : this.tasks.get(ref, accountId);
    if (!version) {
      return { ok: false, issues: [issue('RESOURCE_NOT_FOUND', 'ref', '资源不存在或不属于当前账号')], references };
    }
    if (kind === 'dataset' || kind === 'rule') {
      const active = this.listReferencingTasks(kind, ref, accountId).filter((task) => !task.archived);
      if (active.length > 0) {
        return {
          ok: false,
          issues: [issue(
            'ACTIVE_TASK_REFERENCE',
            'ref',
            `存在 ${active.length} 个未归档任务引用该${kind === 'dataset' ? '数据集' : '规则'}版本`,
          )],
          references: active,
        };
      }
    }
    const existing = this.archives.get(kind, ref, accountId);
    if (existing) return { ok: true, value: existing, replayed: true };
    try {
      return { ok: true, value: this.archives.put(accountId, kind, ref, this.now), replayed: false };
    } catch (error) {
      if (error instanceof ImmutableVersionConflict) {
        return { ok: false, issues: [issue('ARCHIVE_CONFLICT', 'ref', error.message)], references };
      }
      throw error;
    }
  }

  /** 写入任务配置：三个引用必须存在且归属同一账号，绑定冻结后不可变。 */
  createTaskConfig(
    ownerAccountId: string,
    taskRef: VersionRef,
    binding: TaskBinding,
  ): BindingResult<TaskBinding> {
    const issues: BindingIssue[] = [];
    if (!ownerAccountId?.trim()) issues.push(issue('INVALID_INPUT', 'ownerAccountId', '账号不能为空'));
    try { requireRef(taskRef, 'taskRef'); } catch (error) {
      issues.push(issue('INVALID_INPUT', 'taskRef', (error as Error).message));
    }

    const resolve = <T>(
      table: VersionStore<T>,
      ref: VersionRef | undefined,
      field: string,
      code: BindingErrorCode,
      label: string,
      archiveKind?: ArchivableResourceKind,
      archivedCode?: BindingErrorCode,
    ): ResourceVersion<T> | undefined => {
      if (typeof ref?.id !== 'string' || !ref.id.trim() || typeof ref.version !== 'string' || !ref.version.trim()) {
        issues.push(issue('INVALID_INPUT', field, `${label}引用不完整`));
        return undefined;
      }
      const record = table.get(ref, ownerAccountId);
      if (!record) {
        issues.push(issue(code, field, `${label}版本不存在`));
        return undefined;
      }
      if (archiveKind && this.archives.get(archiveKind, ref, ownerAccountId)) {
        issues.push(issue(archivedCode ?? 'BINDING_MISMATCH', field, `${label}版本已归档，不能用于新建任务`));
      }
      return record;
    };

    resolve(this.scenarios, binding?.scenario, 'binding.scenario', 'SCENARIO_NOT_FOUND', '场景配置');
    resolve(this.datasets, binding?.dataset, 'binding.dataset', 'DATASET_NOT_FOUND', '数据集', 'dataset', 'DATASET_ARCHIVED');
    resolve(this.rules, binding?.rule, 'binding.rule', 'RULE_NOT_FOUND', '规则', 'rule', 'RULE_ARCHIVED');

    const scheduleIssue = validateSchedule(binding?.schedule, 'binding.schedule');
    if (scheduleIssue) issues.push(scheduleIssue);
    if (!Array.isArray(binding?.variableMappings)) {
      issues.push(issue('INVALID_INPUT', 'binding.variableMappings', '变量映射必须是数组'));
    } else {
      const placeholders = new Set<string>();
      for (const mapping of binding.variableMappings) {
        if (![mapping?.placeholder, mapping?.source, mapping?.path].every((v) => typeof v === 'string' && v.trim())) {
          issues.push(issue('INVALID_INPUT', 'binding.variableMappings', '变量映射字段不完整'));
          continue;
        }
        if (placeholders.has(mapping.placeholder)) {
          issues.push(issue('INVALID_INPUT', 'binding.variableMappings', `占位符重复：${mapping.placeholder}`));
        }
        placeholders.add(mapping.placeholder);
      }
    }

    if (issues.length > 0) return { ok: false, issues };
    if (typeof binding.name !== 'string' || !binding.name.trim()) {
      // 旧版允许空名称。已有版本仍交给存储层校验内容哈希，保持重放与冲突语义。
      if (!this.tasks.get(taskRef, ownerAccountId)) {
        return { ok: false, issues: [issue('INVALID_INPUT', 'binding.name', '任务名称不能为空')] };
      }
    }
    try {
      return { ok: true, value: this.tasks.put(ownerAccountId, taskRef, binding, this.now) };
    } catch (error) {
      if (error instanceof ImmutableVersionConflict) return { ok: false, issues: [issue('VERSION_CONFLICT', 'taskRef', error.message)] };
      throw error;
    }
  }

  /**
   * 运行索引写入前的引用校验：任务必须存在且归属账号，运行声明的三个版本
   * 必须与任务已冻结的绑定一致，且版本记录仍存在。
   */
  validateRunBindings(ownerAccountId: string, taskRef: VersionRef, runRefs: {
    scenario: VersionRef;
    dataset: VersionRef;
    rule: VersionRef;
  }): BindingResult<TaskBinding> {
    const issues: BindingIssue[] = [];
    const task = this.tasks.get(taskRef, ownerAccountId);
    if (!task) {
      return { ok: false, issues: [issue('TASK_NOT_FOUND', 'taskRef', '任务不存在或不属于当前账号')] };
    }
    if (this.archives.get('task', taskRef, ownerAccountId)) {
      return { ok: false, issues: [issue('TASK_ARCHIVED', 'taskRef', '任务已归档，不能发起新运行')] };
    }
    const bound = task.snapshot;
    const pairs: [keyof typeof runRefs, VersionRef, VersionRef, string][] = [
      ['scenario', runRefs.scenario, bound.scenario, '场景配置'],
      ['dataset', runRefs.dataset, bound.dataset, '数据集'],
      ['rule', runRefs.rule, bound.rule, '规则'],
    ];
    for (const [field, runRef, boundRef, label] of pairs) {
      if (!runRef || runRef.id !== boundRef.id || runRef.version !== boundRef.version) {
        issues.push(issue('BINDING_MISMATCH', field, `运行${label}版本与任务绑定不一致`));
        continue;
      }
      let table: VersionStore<unknown>;
      if (field === 'scenario') table = this.scenarios as VersionStore<unknown>;
      else if (field === 'dataset') table = this.datasets as VersionStore<unknown>;
      else table = this.rules as VersionStore<unknown>;
      if (!table.get(runRef, ownerAccountId)) {
        issues.push(issue('BINDING_MISMATCH', field, `${label}版本已不存在或归属不符`));
      }
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: task };
  }
}
