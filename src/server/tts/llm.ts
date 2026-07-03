import fs from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './utils';
import type { AnyRecord, LLMClient, LLMJsonRequest, LLMSettings } from './types';

export class LLMJsonParseError extends Error {
  constructor(message: string, readonly content: string, readonly normalizedContent: string, readonly causeError?: unknown) {
    super(message);
    this.name = 'LLMJsonParseError';
  }
}

export class LLMUpstreamResponseError extends Error {
  constructor(
    message: string,
    readonly responseBody: string,
    readonly metadata: { status: number; statusText: string; contentType: string; requestId: string },
    readonly causeError?: unknown,
  ) {
    super(message);
    this.name = 'LLMUpstreamResponseError';
  }
}

export function createLLMClient(settings: LLMSettings): LLMClient {
  const provider = settings.provider.toLowerCase().trim();
  if (['openai', 'openai_compatible', 'compatible'].includes(provider)) return new OpenAICompatibleLLMClient(settings);
  if (provider === 'mock') return new MockLLMClient();
  throw new Error(`Unsupported LLM provider: ${settings.provider}`);
}

export class OpenAICompatibleLLMClient implements LLMClient {
  constructor(private readonly settings: LLMSettings) {}

  async generateJson(request: LLMJsonRequest): Promise<AnyRecord> {
    const attempts = Math.max(1, this.settings.retryMaxAttempts);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let content = '';
      try {
        content = await this.chat(request);
        return parseJsonContent(content);
      } catch (error) {
        lastError = error;
        this.logFailure(attempt, attempts, error, content);
        if (attempt >= attempts) break;
        await sleep(this.retrySleepSeconds(attempt) * 1000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LLM request failed without an exception');
  }

  private async chat(request: LLMJsonRequest): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey) headers.Authorization = `Bearer ${this.settings.apiKey}`;
    const payload: AnyRecord = {
      model: this.settings.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      temperature: this.settings.temperature,
      max_tokens: this.settings.maxOutputTokens,
      ...(request.responseFormatJson ?? true ? { response_format: { type: 'json_object' } } : {}),
      ...(request.extra ?? {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.settings.timeoutSeconds * 1000);
    let response: Response;
    try {
      response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const responseBody = await response.text();
    if (!response.ok) {
      throw this.createUpstreamResponseError(response, responseBody, `OpenAI-compatible HTTP ${response.status}`);
    }
    if (!responseBody.trim()) {
      throw this.createUpstreamResponseError(response, responseBody, `OpenAI-compatible response body is empty (HTTP ${response.status})`);
    }
    let data: AnyRecord;
    try {
      data = JSON.parse(responseBody) as AnyRecord;
    } catch (error) {
      throw this.createUpstreamResponseError(response, responseBody, `OpenAI-compatible response JSON parse failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw this.createUpstreamResponseError(response, responseBody, 'Invalid OpenAI-compatible response: missing choices[0].message.content');
    return content;
  }

  private createUpstreamResponseError(response: Response, responseBody: string, message: string, causeError?: unknown): LLMUpstreamResponseError {
    const contentType = response.headers.get('content-type') || '';
    const requestId =
      response.headers.get('x-request-id') ||
      response.headers.get('x-tt-logid') ||
      response.headers.get('x-trace-id') ||
      response.headers.get('trace-id') ||
      '';
    return new LLMUpstreamResponseError(message, responseBody, { status: response.status, statusText: response.statusText, contentType, requestId }, causeError);
  }

  private retrySleepSeconds(attempt: number): number {
    return Math.max(0, this.settings.retryBackoffSeconds) * 2 ** Math.max(0, attempt - 1);
  }

  private logFailure(attempt: number, attempts: number, error: unknown, content: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const rawContent = error instanceof LLMJsonParseError ? error.content : error instanceof LLMUpstreamResponseError ? error.responseBody : content;
    const normalizedContent = error instanceof LLMJsonParseError ? error.normalizedContent : content;
    const preview = (rawContent || '').slice(0, Math.max(0, this.settings.logFailedResponseChars));
    console.error(`[llm] request failed attempt=${attempt}/${attempts} model=${this.settings.model} error_type=${err.name} error=${err.message}`);
    if (error instanceof LLMUpstreamResponseError) {
      console.error(
        `[llm-upstream-response] status=${error.metadata.status} status_text=${JSON.stringify(error.metadata.statusText)} content_type=${JSON.stringify(error.metadata.contentType)} request_id=${JSON.stringify(error.metadata.requestId)}`,
      );
      if (error.causeError) console.error(`[llm-upstream-response] parse_error=${error.causeError instanceof Error ? error.causeError.message : String(error.causeError)}`);
    }
    if (preview) console.error(`[llm] failed response preview begin\n${preview}\n[llm] failed response preview end`);
    else console.error('[llm] failed response preview is empty');
    if (error instanceof LLMJsonParseError) {
      console.error(`[llm-json-invalid] model=${this.settings.model} attempt=${attempt}/${attempts} parse_error=${error.causeError instanceof Error ? error.causeError.message : String(error.causeError || '')}`);
      console.error(`[llm-json-invalid] raw_response_begin\n${rawContent || ''}\n[llm-json-invalid] raw_response_end`);
      if (normalizedContent !== rawContent) console.error(`[llm-json-invalid] normalized_response_begin\n${normalizedContent}\n[llm-json-invalid] normalized_response_end`);
    }
  }
}

export function parseJsonContent(content: string): AnyRecord {
  let text = content.trim();
  if (text.startsWith('```json')) text = text.slice('```json'.length).trim();
  if (text.startsWith('```')) text = text.slice('```'.length).trim();
  if (text.endsWith('```')) text = text.slice(0, -3).trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LLMJsonParseError('LLM JSON response must be an object', content, text);
    }
    return parsed as AnyRecord;
  } catch (error) {
    if (error instanceof LLMJsonParseError) throw error;
    throw new LLMJsonParseError(`LLM JSON response parse failed: ${error instanceof Error ? error.message : String(error)}`, content, text, error);
  }
}

const INPUT_JSON_RE = /## 输入\s*```json\s*([\s\S]*?)\s*```/;

export class MockLLMClient implements LLMClient {
  async generateJson(request: LLMJsonRequest): Promise<AnyRecord> {
    const payload = extractInputPayload(request.userPrompt);
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : null;
    if (candidates) {
      return {
        candidates: candidates.map((candidate: AnyRecord) => ({
          is_chapter_title: true,
          normalized_title: String(candidate?.title || ''),
          confidence: 1,
          reason: 'mock provider accepts supplied chapter title candidate',
        })),
        mock: true,
      };
    }
    const quoteCandidates = Array.isArray(payload.quote_candidates) ? payload.quote_candidates : null;
    if (quoteCandidates) {
      return {
        candidates: quoteCandidates.map(() => ({
          is_dialogue: false,
          speaker: 'unknown_speaker',
          speaker_gender: 'unknown',
          alias_used: '',
          dialogue_text: '',
          emotion: '平稳叙述',
          confidence: 1,
          reason: 'mock provider does not recover quote spans',
        })),
        aliases: [],
        mock: true,
      };
    }
    const roleGroups = Array.isArray(payload.role_groups) ? payload.role_groups : null;
    if (roleGroups) {
      return {
        group_profiles: roleGroups.map((group: AnyRecord) => ({
          group_id: String(group?.group_id || ''),
          gender: String(group?.gender || 'unknown'),
          age_group: '未知',
          description: mockMinorGroupVoiceDescription(group),
          confidence: 0.45,
        })),
        mock: true,
      };
    }
    const roles = Array.isArray(payload.roles) ? payload.roles : null;
    if (roles) {
      return {
        voice_profiles: roles.map((role: AnyRecord) => ({
          canonical_name: String(role?.canonical_name || ''),
          gender: String(role?.gender || 'unknown'),
          age_group: '未知',
          description: mockVoiceDescription(role),
          confidence: 0.5,
        })),
        mock: true,
      };
    }
    return { dialogue_spans: [], aliases: [], mock: true, note: 'Mock provider does not perform extraction.' };
  }
}

function extractInputPayload(prompt: string): AnyRecord {
  const match = INPUT_JSON_RE.exec(prompt);
  if (!match) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mockVoiceDescription(role: AnyRecord): string {
  const gender = String(role?.gender || 'unknown');
  if (gender === 'male') return '男性声线，音色自然，发声清晰';
  if (gender === 'female') return '女性声线，音色自然，发声清晰';
  return '中性声线，音色自然，发声清晰';
}

function mockMinorGroupVoiceDescription(group: AnyRecord): string {
  const gender = String(group?.gender || 'unknown');
  if (gender === 'male') return '青年男性配角声线，音色自然偏稳，吐字清晰，语速中等';
  if (gender === 'female') return '青年女性配角声线，音色自然清亮，吐字清晰，语速中等';
  return '中性配角声线，音色自然，发声清晰，语速中等';
}

export async function renderPrompt(filename: string, variables: Record<string, string>): Promise<string> {
  const promptPath = path.join(process.cwd(), 'src/server/tts/prompts', filename);
  let rendered = await fs.readFile(promptPath, 'utf8');
  for (const [key, value] of Object.entries(variables)) rendered = rendered.replaceAll(`{{${key}}}`, value);
  return rendered;
}
