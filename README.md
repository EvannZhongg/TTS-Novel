# novelmind

novelmind 是一个面向中文小说文本的智能分析与多角色 TTS 前处理工具。它把小说 TXT 输入转成结构化的章节、对白、角色、声线和 TTS segment 数据，并提供可视化界面用于检查章节判断、LLM 抽取、原文定位和导出分析结果。

当前项目是一个 Next.js 单体应用：前端可视化页面和后端 pipeline API 部署在同一个应用中，所有请求都走同源 `/api/v1`。

## 主要能力

- TXT 上传 / 粘贴输入，并自动处理常见文本编码。
- 小说章节标题候选识别，并可通过 LLM 判断真实章节标题。
- 章节拆分、正文清洗、chunk 切分。
- 使用 OpenAI-compatible LLM 抽取多角色对白 span。
- 对 LLM 输出做 source grounding，定位对白在原文中的位置。
- 从引号文本中补抽遗漏对白，并修复部分引号边界问题。
- 合并角色 aliases、性别投票结果，并生成角色声线 profile。
- 生成旁白 / 对白 TTS segments，包含 speaker、emotion、voice profile、定位信息。
- 前端展示章节、chunk、span、TTS 覆盖和运行日志。
- 导出分析 JSON，包含 normalized text、明确坐标说明、job logs 和 error 信息。

## 技术栈

- Next.js App Router
- React
- TypeScript
- Node.js runtime API Routes
- OpenAI-compatible Chat Completions API
- 本地文件系统 job store，Vercel 上默认使用 `/tmp/tts-pipeline-data`

## 目录结构

```text
app/
  page.tsx                                  # 可视化页面
  layout.tsx                                # 全局布局，引入 public/app.js
  globals.css                               # 页面样式
  api/v1/**/route.ts                        # 同源 API Route Handlers

public/
  app.js                                    # 前端交互、可视化、导入导出逻辑

src/server/tts/
  config.ts                                 # 环境变量配置
  service.ts                                # job 创建、轮询、存储、结果保存
  jobStore.ts                               # job.json / result.json / events.jsonl 文件存储
  runner.ts                                 # pipeline 主编排
  text.ts                                   # 文本预处理、章节识别、chunk、引号候选
  grounding.ts                              # source grounding
  runnerHelpers.ts                          # aliases、声线、TTS segment 等辅助逻辑
  llm.ts                                    # OpenAI-compatible / mock LLM client
  prompts/*.md                              # LLM prompts
```

## 本地运行

```bash
cp .env.example .env
npm install
npm run dev
```

打开：

```text
http://localhost:3000
```

如需不依赖外部 LLM 快速验证页面和 pipeline 流程，可以使用 mock provider：

```bash
LLM_PROVIDER=mock npm run dev
```

## 环境变量

常用配置在 `.env.example` 中。

### 应用配置

```env
APP_ENV=development
# 本地默认 ./data；Vercel 默认 /tmp/tts-pipeline-data
# APP_DATA_DIR=./data
```

### LLM 配置

```env
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=120
LLM_TEMPERATURE=0
LLM_MAX_OUTPUT_TOKENS=8192
LLM_RETRY_MAX_ATTEMPTS=3
LLM_RETRY_BACKOFF_SECONDS=1.0
LLM_LOG_FAILED_RESPONSE_CHARS=2000
```

`LLM_BASE_URL` 应填写 OpenAI-compatible API 的 base URL，不要包含 `/chat/completions`，代码会自动拼接：

```text
{LLM_BASE_URL}/chat/completions
```

### Pipeline 配置

```env
PIPELINE_CHUNK_MAX_CHARS=800
PIPELINE_CHUNK_OVERLAP_CHARS=0
PIPELINE_MAX_PARALLEL_CHAPTERS=3

PIPELINE_CHAPTER_TITLE_VALIDATION_ENABLED=true
PIPELINE_CHAPTER_TITLE_VALIDATION_BATCH_SIZE=30
PIPELINE_CHAPTER_TITLE_CONTEXT_LINES=2

PIPELINE_GROUNDING_ENABLED=true
PIPELINE_GROUNDING_FUZZY_MIN_SCORE=0.9
PIPELINE_GROUNDING_EVIDENCE_FUZZY_MIN_SCORE=0.86
PIPELINE_GROUNDING_AMBIGUITY_MARGIN=0.03
PIPELINE_GROUNDING_EVIDENCE_WINDOW_CHARS=240

PIPELINE_QUOTE_SPAN_RECOVERY_ENABLED=true
PIPELINE_QUOTE_SPAN_RECOVERY_CONTEXT_CHARS=80
PIPELINE_QUOTE_SPAN_RECOVERY_BATCH_SIZE=20

PIPELINE_ROLE_VOICE_PROFILE_ENABLED=true
PIPELINE_ROLE_VOICE_PROFILE_EVIDENCE_MAX_CHARS=1600
PIPELINE_ROLE_VOICE_PROFILE_BATCH_SIZE=8
PIPELINE_ROLE_VOICE_PROFILE_MAX_PARALLEL_BATCHES=3
PIPELINE_ROLE_VOICE_PROFILE_MINOR_SPAN_THRESHOLD=1
```

## 使用流程

1. 点击页面右上角“上传 TXT”，上传小说 TXT 或直接粘贴文本。
2. 填写书名。
3. 点击“运行完整 Pipeline”。
4. 页面会创建 job，并持续轮询 `/api/v1/pipeline/jobs/{job_id}`。
5. 运行过程中可查看已完成章节、当前任务日志和 progressive partial result。
6. 完成后可以查看章节 / chunk / span、原文高亮、TTS 覆盖、角色 aliases 和声线 profile。
7. 点击“导出 JSON”得到 `.pipeline-analysis.json` 分析包。

## API

### 健康检查

```text
GET /api/v1/health
```

返回服务状态、环境、LLM provider 和模型信息。

### LLM 测试

```text
POST /api/v1/llm/test
```

请求：

```json
{
  "text": "Return {\"ok\": true}"
}
```

### 章节预览

```text
POST /api/v1/pipeline/chapter-preview
```

只执行预处理、章节候选识别、章节拆分和 chunk 预览，不执行完整 dialogue span 抽取。

### 同步运行完整 Pipeline

```text
POST /api/v1/pipeline/run
```

该接口会等待 pipeline 完成后返回完整结果。长文本更建议使用 job 接口。

### 创建 Pipeline Job

```text
POST /api/v1/pipeline/jobs
```

请求：

```json
{
  "book_title": "demo",
  "text": "第1章 ...",
  "chapter_ids": null
}
```

返回：

```json
{
  "job_id": "...",
  "status": "queued",
  "storage": {}
}
```

### 查询 Job

```text
GET /api/v1/pipeline/jobs/{job_id}?include_result=false&log_tail=5000
```

常用 query：

- `include_result=true`：完成后返回完整 `result`。
- `log_tail=5000`：返回最新 N 条日志。

### 查询 Job 日志

```text
GET /api/v1/pipeline/jobs/{job_id}/logs?tail=5000
```

### 保存 / 获取前端分析结果

```text
POST /api/v1/pipeline/jobs/{job_id}/frontend-result
GET  /api/v1/pipeline/jobs/{job_id}/frontend-result
```

前端在 pipeline 完成后会保存一份前端重映射后的分析包到 job 目录，文件名为 `frontend_result.json`。

## 结果文件

每个 job 会写入一个目录。默认路径：

- 本地：`./data/pipeline_jobs/{job_id}`
- Vercel：`/tmp/tts-pipeline-data/pipeline_jobs/{job_id}`

主要文件：

```text
job.json                  # job 元数据
request.json              # 原始请求
events.jsonl              # 运行日志
partial_result.json       # progressive partial result
result.json               # 后端完整 result
frontend_result.json      # 前端分析包
error.json                # 失败信息
```

### 坐标说明

导出包内会写入 `coordinate_systems.fields`，用于解释各类坐标字段。核心规则：

- `input.normalized_text` 是前端统一换行后的分析文本。
- `display_*` 坐标以 `input.normalized_text` 为基准。
- `clean_*` 坐标以单章 `cleanChapterText` 后的 cleaned chapter text 为基准。
- 前端导出的 `chapter.start/end`、`chunk.start/end`、`span.start/end` 通常是展示坐标，等同于对应的 `display_*`。
- `chapter.source_start/source_end` 表示后端拆章后的章节正文在 `cleanBeforeChapterSplit` 文本中的坐标，仅在前端重映射后存在。

## Pipeline 输出概览

完整 `result` 中包含：

- `preprocessing`：预处理统计。
- `chapter_title_detection`：章节候选和 LLM 判断结果。
- `grounding`：定位配置和阈值。
- `quote_span_recovery`：引号补抽配置和结果。
- `aliases`：全书角色别名和性别投票结果。
- `role_registry`：角色声线 profile。
- `cleaned_text`：全书清洗后文本。
- `tts_segments` / `tts_segment_summary`：全书 TTS segments。
- `chapters`：章节级结构，每章包含 chunks、LLM 原始结果、grounding 结果、quote recovery 结果和 chapter 级 TTS segments。

## Vercel 部署

1. 在 Vercel Project Settings 中配置 `.env.example` 中的 LLM 和 pipeline 环境变量。
2. API routes 使用 Node.js runtime，并设置 `maxDuration = 300`；实际可用时长仍取决于 Vercel 账号和计划限制。
3. `POST /api/v1/pipeline/jobs` 使用 Next.js `after()` 在返回 job id 后继续执行后台 pipeline。
4. 超长文本、大量章节或大量 LLM 请求可能超过函数最长执行时间，生产长期任务建议接入队列和持久化存储。
5. 如果使用内网或企业代理 LLM，请确认 Vercel 部署区域可以访问该 `LLM_BASE_URL`。

## 校验

```bash
npm run typecheck
npm run build
```

也可以先使用 mock provider 做端到端验证：

```bash
LLM_PROVIDER=mock npm run dev
```

## 已知限制

- 当前 job store 是文件系统实现，不适合作为生产级持久化数据库。
- Vercel `/tmp` 数据可能随实例回收而消失。
- 长任务依赖平台函数时长限制。
- 前端导入 JSON 只支持 `tts_pipeline_analysis_v1` 新格式。
- 当前输出是 TTS 前处理结构化数据，不直接生成音频文件。
