import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AnyRecord } from './types';

export class PipelineJobStore {
  constructor(private readonly rootDir: string, private readonly maxRecentLogs = 500) {}

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async createJob({ jobId, requestPayload, createdAt }: { jobId: string; requestPayload: AnyRecord; createdAt: string }): Promise<AnyRecord> {
    await this.ensureRoot();
    const jobDir = this.jobDir(jobId);
    await fs.mkdir(jobDir, { recursive: false });
    await writeJson(path.join(jobDir, 'request.json'), requestPayload);
    const job: AnyRecord = {
      job_id: jobId,
      status: 'queued',
      stage: 'queued',
      message: '任务已创建，等待执行',
      created_at: createdAt,
      started_at: null,
      completed_at: null,
      logs: [],
      result: null,
      error: null,
      storage: this.storageInfo(jobId),
      request_summary: { book_title: requestPayload.book_title || 'untitled', chapter_ids: requestPayload.chapter_ids, text_chars: String(requestPayload.text || '').length },
    };
    await this.saveJobMetadata(job);
    return job;
  }

  async appendLog(job: AnyRecord, event: AnyRecord): Promise<AnyRecord> {
    const item = { ...event };
    job.stage = item.stage ?? job.stage;
    job.message = item.message ?? job.message;
    job.logs ??= [];
    job.logs.push(item);
    if (job.logs.length > this.maxRecentLogs) job.logs = job.logs.slice(-this.maxRecentLogs);
    await appendJsonl(this.eventsFile(String(job.job_id)), item);
    await this.saveJobMetadata(job);
    return item;
  }

  async saveJobMetadata(job: AnyRecord): Promise<void> {
    const jobId = String(job.job_id);
    const persisted: AnyRecord = {};
    for (const [key, value] of Object.entries(job)) {
      if (!['logs', 'result', 'partial_result'].includes(key)) persisted[key] = value;
    }
    persisted.storage = this.storageInfo(jobId);
    await writeJson(this.metadataFile(jobId), persisted);
  }

  async saveResult(job: AnyRecord, result: AnyRecord): Promise<void> {
    const jobId = String(job.job_id);
    await writeJson(path.join(this.jobDir(jobId), 'result.json'), result);
    job.result = result;
    job.storage = this.storageInfo(jobId);
    await this.saveJobMetadata(job);
  }

  async savePartialResult(job: AnyRecord, partialResult: AnyRecord): Promise<void> {
    const jobId = String(job.job_id);
    await writeJson(path.join(this.jobDir(jobId), 'partial_result.json'), partialResult);
    job.partial_result = partialResult;
    job.storage = this.storageInfo(jobId);
    await this.saveJobMetadata(job);
  }

  async readPartialResult(jobId: string): Promise<AnyRecord | null> {
    const file = path.join(this.jobDir(jobId), 'partial_result.json');
    if (!existsSync(file)) return null;
    return readJson(file);
  }

  async saveError(job: AnyRecord, error: AnyRecord): Promise<void> {
    const jobId = String(job.job_id);
    await writeJson(path.join(this.jobDir(jobId), 'error.json'), error);
    job.storage = this.storageInfo(jobId);
    await this.saveJobMetadata(job);
  }

  async saveFrontendResult(jobId: string, payload: AnyRecord): Promise<AnyRecord> {
    await writeJson(path.join(this.jobDir(jobId), 'frontend_result.json'), payload);
    return this.storageInfo(jobId);
  }

  jobExists(jobId: string): boolean {
    return existsSync(this.metadataFile(jobId));
  }

  async getFrontendResult(jobId: string): Promise<AnyRecord | null> {
    const file = path.join(this.jobDir(jobId), 'frontend_result.json');
    if (!existsSync(file)) return null;
    return readJson(file);
  }

  async getJob(jobId: string, { includeLogs = true, includeResult = true, logTail = undefined as number | undefined } = {}): Promise<AnyRecord | null> {
    const metadataFile = this.metadataFile(jobId);
    if (!existsSync(metadataFile)) return null;
    const job = await readJson(metadataFile);
    job.logs = includeLogs ? await this.readLogs(jobId, logTail) : [];
    if (includeResult && job.status === 'completed') {
      const resultFile = path.join(this.jobDir(jobId), 'result.json');
      job.result = existsSync(resultFile) ? await readJson(resultFile) : null;
    } else {
      job.result = null;
    }
    job.storage = this.storageInfo(jobId);
    return job;
  }

  async listJobs(limit = 100): Promise<AnyRecord[]> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const items: AnyRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadataFile = path.join(this.rootDir, entry.name, 'job.json');
      if (!existsSync(metadataFile)) continue;
      try {
        const job = await readJson(metadataFile);
        job.logs = [];
        job.result = null;
        job.storage = this.storageInfo(String(job.job_id || entry.name));
        items.push(job);
      } catch {
        // Ignore corrupt job metadata.
      }
    }
    return items.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, Math.max(1, limit));
  }

  async readLogs(jobId: string, tail?: number): Promise<AnyRecord[]> {
    const eventsFile = this.eventsFile(jobId);
    if (!existsSync(eventsFile)) return [];
    let lines = (await fs.readFile(eventsFile, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
    if (tail !== undefined) {
      if (tail <= 0) return [];
      lines = lines.slice(-tail);
    }
    const logs: AnyRecord[] = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item && typeof item === 'object' && !Array.isArray(item)) logs.push(item);
      } catch {
        // Skip invalid jsonl row.
      }
    }
    return logs;
  }

  storageInfo(jobId: string): AnyRecord {
    const jobDir = this.jobDir(jobId);
    return {
      job_dir: jobDir,
      metadata_path: path.join(jobDir, 'job.json'),
      request_path: path.join(jobDir, 'request.json'),
      events_path: path.join(jobDir, 'events.jsonl'),
      result_path: path.join(jobDir, 'result.json'),
      frontend_result_path: path.join(jobDir, 'frontend_result.json'),
      partial_result_path: path.join(jobDir, 'partial_result.json'),
      error_path: path.join(jobDir, 'error.json'),
    };
  }

  private metadataFile(jobId: string): string {
    return path.join(this.jobDir(jobId), 'job.json');
  }

  private eventsFile(jobId: string): string {
    return path.join(this.jobDir(jobId), 'events.jsonl');
  }

  private jobDir(jobId: string): string {
    return path.join(this.rootDir, jobId);
  }
}

async function readJson(file: string): Promise<AnyRecord> {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Expected JSON object in ${file}`);
  return data;
}

async function writeJson(file: string, data: AnyRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, file);
}

async function appendJsonl(file: string, item: AnyRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(item)}\n`, 'utf8');
}
