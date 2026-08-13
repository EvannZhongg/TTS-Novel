/**
 * 录制/回放 LLM 客户端。
 *
 * 为什么需要它: MockLLMClient(llm.ts:154)虽然可用且确定性, 但它的
 * dialogue_spans 永远返回空数组(llm.ts:212), 于是 span 抽取、source grounding、
 * 引号补抽这些最复杂的代码路径根本不会被执行。用 mock 做等价性基准会漏掉
 * 恰恰最容易改坏的 600 行逻辑。
 *
 * 做法: record 模式下用真实 LLM 跑一遍并把每个请求/响应存盘; replay 模式下
 * 按请求内容的哈希命中缓存, 完全离线且确定性, 从而可以对重构前后做逐字节比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AnyRecord, LLMClient, LLMJsonRequest } from './types';

function fingerprint(request: LLMJsonRequest): string {
  const basis = JSON.stringify({
    system: request.systemPrompt,
    user: request.userPrompt,
    json: request.responseFormatJson ?? null,
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

interface CassetteEntry {
  key: string;
  response: AnyRecord;
}

export class CassetteLLMClient implements LLMClient {
  private readonly entries = new Map<string, AnyRecord>();
  /** 同一请求可能出现多次(不同章节的相同 prompt), 用计数区分调用顺序无关性 */
  private misses = 0;

  constructor(
    private readonly cassettePath: string,
    private readonly mode: 'record' | 'replay',
    private readonly inner?: LLMClient,
  ) {
    if (fs.existsSync(cassettePath)) {
      const raw = JSON.parse(fs.readFileSync(cassettePath, 'utf8')) as CassetteEntry[];
      for (const entry of raw) this.entries.set(entry.key, entry.response);
    } else if (mode === 'replay') {
      throw new Error(`cassette 不存在: ${cassettePath}(请先用 record 模式生成)`);
    }
  }

  async generateJson(request: LLMJsonRequest): Promise<AnyRecord> {
    const key = fingerprint(request);
    const cached = this.entries.get(key);
    if (cached) return JSON.parse(JSON.stringify(cached));

    if (this.mode === 'replay') {
      this.misses += 1;
      throw new Error(
        `cassette 未命中(第 ${this.misses} 次): key=${key}\n` +
          `prompt 首 200 字: ${request.userPrompt.slice(0, 200)}\n` +
          '说明重构改变了发给 LLM 的 prompt 内容。',
      );
    }

    if (!this.inner) throw new Error('record 模式需要提供 inner client');
    const response = await this.inner.generateJson(request);
    // 只写一次: 同一 prompt 若被两条路径先后请求, 后者不得覆盖前者。
    // 否则两条路径会各自拿到 LLM 对同一 prompt 的不同回答(模型本身有随机性),
    // 比对结果全是噪声 —— 这个坑已经踩过一次。
    if (!this.entries.has(key)) {
      this.entries.set(key, response);
      this.flush();
    }
    return JSON.parse(JSON.stringify(this.entries.get(key)));
  }

  private flush(): void {
    const dir = path.dirname(this.cassettePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: CassetteEntry[] = [...this.entries.entries()].map(([key, response]) => ({ key, response }));
    fs.writeFileSync(this.cassettePath, JSON.stringify(payload, null, 2));
  }

  get size(): number {
    return this.entries.size;
  }
}
