/**
 * 结果读取接口的 SQLite 只读存储实现。
 *
 * 与 InMemoryReadStore 实现同一 ReadStore 接口，三条 handler 与 HTTP 层无需改动。
 * 归属在 SQL 的 WHERE 子句中限定（id + owner_account_id），不是读回后再过滤：
 * 越权与不存在的批次在存储层都表现为「查不到」，再由 handler 统一为 404。
 * 运行时冻结的规则版本、裁判原始响应与完整业务 JSON 一并落盘，供 Trace 到期后读取。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EvidenceRef, JudgeAttempt, RuleDef } from '../result-contract/contract.ts';
import type { ReadStore, RunRecord, SampleRecord, TraceRef } from '../result-api/store.ts';
import { validateRunRecord } from '../result-api/store.ts';
import { applyMigrations, openDatabase } from './migrations.ts';

interface RunRow {
  id: string;
  owner_account_id: string;
  task_id: string;
  dataset_version_id: string;
  rule_version_id: string;
  rule_json: string;
  triggered_by: string;
  triggered_at: string;
  status: string;
  progress_completed: number | null;
  progress_total: number | null;
}

type SampleRow = {
  id: string;
  query: string;
  answer_summary: string | null;
  answer: string | null;
  duration_ms: number | null;
  effective_attempt_id: string | null;
  evidence_json: string | null;
  trace_json: string | null;
}

type AttemptRow = {
  sample_id: string;
  id: string;
  raw_response: string | null;
  business_json: string | null;
  has_business_json: number;
}

function optionalJson<T>(text: string | null): T | undefined {
  return text === null ? undefined : JSON.parse(text) as T;
}

/** 打开（必要时建库并迁移）SQLite 文件，返回可直接交给结果 API 的只读存储。 */
export function openSqliteStore(filePath: string): SqliteReadStore {
  const db = openDatabase(filePath);
  try {
    applyMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteReadStore(db);
}

export class SqliteReadStore implements ReadStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 写入一条完整运行记录（含样本、尝试与冻结规则快照）。成功后立即可读。 */
  insertRun(record: RunRecord): void {
    validateRunRecord(record);

    const insertRun = this.db.prepare(`
      INSERT INTO runs(
        id, owner_account_id, task_id, dataset_version_id, rule_version_id, rule_json,
        triggered_by, triggered_at, status, progress_completed, progress_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSample = this.db.prepare(`
      INSERT INTO samples(
        run_id, id, ordinal, query, answer_summary, answer, duration_ms,
        effective_attempt_id, evidence_json, trace_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAttempt = this.db.prepare(`
      INSERT INTO judge_attempts(
        run_id, sample_id, id, ordinal, raw_response, business_json, has_business_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertRun.run(
        record.id,
        record.ownerAccountId,
        record.taskId,
        record.datasetVersionId,
        record.ruleVersionId,
        JSON.stringify(record.rule),
        record.triggeredBy,
        record.triggeredAt,
        record.status,
        record.progress?.completed ?? null,
        record.progress?.total ?? null,
      );
      record.samples.forEach((sample, sampleIndex) => {
        insertSample.run(
          record.id,
          sample.id,
          sampleIndex,
          sample.query,
          sample.answerSummary ?? null,
          sample.answer ?? null,
          sample.durationMs ?? null,
          sample.effectiveAttemptId ?? null,
          sample.evidence ? JSON.stringify(sample.evidence) : null,
          sample.trace ? JSON.stringify(sample.trace) : null,
        );
        sample.attempts.forEach((attempt, attemptIndex) => {
          const hasBusinessJson = attempt.businessJson !== undefined ? 1 : 0;
          insertAttempt.run(
            record.id,
            sample.id,
            attempt.id,
            attemptIndex,
            attempt.rawResponse,
            hasBusinessJson ? JSON.stringify(attempt.businessJson) : null,
            hasBusinessJson,
          );
        });
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 账号与批次归属同时限定；未登录、越权与不存在均返回 undefined。 */
  findRunForAccount(runId: string, accountId: string | undefined): RunRecord | undefined {
    if (!accountId) return undefined;
    const row = this.db.prepare(`
      SELECT id, owner_account_id, task_id, dataset_version_id, rule_version_id, rule_json,
             triggered_by, triggered_at, status, progress_completed, progress_total
      FROM runs WHERE id = ? AND owner_account_id = ?
    `).get(runId, accountId) as RunRow | undefined;
    if (!row) return undefined;

    const sampleRows = this.db.prepare(`
      SELECT id, query, answer_summary, answer, duration_ms, effective_attempt_id,
             evidence_json, trace_json
      FROM samples WHERE run_id = ? ORDER BY ordinal
    `).all(runId) as SampleRow[];
    const attemptRows = this.db.prepare(`
      SELECT sample_id, id, raw_response, business_json, has_business_json
      FROM judge_attempts WHERE run_id = ? ORDER BY sample_id, ordinal
    `).all(runId) as AttemptRow[];
    const attemptsBySample = new Map<string, JudgeAttempt[]>();
    for (const row of attemptRows) {
      const attempts = attemptsBySample.get(row.sample_id) ?? [];
      const attempt: JudgeAttempt = { id: row.id, rawResponse: row.raw_response };
      if (row.has_business_json === 1) attempt.businessJson = JSON.parse(row.business_json ?? 'null');
      attempts.push(attempt);
      attemptsBySample.set(row.sample_id, attempts);
    }

    const samples: SampleRecord[] = sampleRows.map((sampleRow) => {
      const attempts = attemptsBySample.get(sampleRow.id) ?? [];
      const sample: SampleRecord = { id: sampleRow.id, query: sampleRow.query, attempts };
      if (sampleRow.answer_summary !== null) sample.answerSummary = sampleRow.answer_summary;
      if (sampleRow.answer !== null) sample.answer = sampleRow.answer;
      if (sampleRow.duration_ms !== null) sample.durationMs = sampleRow.duration_ms;
      if (sampleRow.effective_attempt_id !== null) sample.effectiveAttemptId = sampleRow.effective_attempt_id;
      const evidence = optionalJson<EvidenceRef>(sampleRow.evidence_json);
      if (evidence) sample.evidence = evidence;
      const trace = optionalJson<TraceRef>(sampleRow.trace_json);
      if (trace) sample.trace = trace;
      return sample;
    });

    const run: RunRecord = {
      id: row.id,
      ownerAccountId: row.owner_account_id,
      taskId: row.task_id,
      datasetVersionId: row.dataset_version_id,
      ruleVersionId: row.rule_version_id,
      rule: JSON.parse(row.rule_json) as RuleDef,
      triggeredBy: row.triggered_by as RunRecord['triggeredBy'],
      triggeredAt: row.triggered_at,
      status: row.status as RunRecord['status'],
      samples,
    };
    if (row.progress_completed !== null && row.progress_total !== null) {
      run.progress = { completed: row.progress_completed, total: row.progress_total };
    }
    return run;
  }

  close(): void {
    this.db.close();
  }
}
