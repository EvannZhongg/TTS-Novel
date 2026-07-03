# TTS Pipeline Next.js 单体版

## 目录

```text
app/                         # Next.js App Router 页面与 API Route Handlers
  page.tsx                   # 可视化页面
  layout.tsx                 # 全局布局，引入 public/app.js
  globals.css                # 原 demo 样式迁移
  api/v1/**/route.ts         # 同源 API
public/app.js                # 原 demo 交互逻辑，已改为请求同源 API
src/server/tts/              # TypeScript 版 pipeline 服务端实现
  runner.ts                  # 主 pipeline 编排
  text.ts                    # 预处理、章节识别、chunk、引号候选
  grounding.ts               # source grounding
  llm.ts                     # OpenAI-compatible / mock LLM client
  jobStore.ts                # 任务元数据、日志、结果文件存储
  prompts/*.md               # 原 Python 后端 prompts
```

## 本地运行

```bash
cp .env.example .env
# 填写 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
npm install
npm run dev
```

打开 `http://localhost:3000`。前端不再需要填写 Backend API，所有请求都走同源 `/api/v1`。

如需无外部 LLM 快速验证：

```bash
LLM_PROVIDER=mock npm run dev
```

## API

保持原有 API 前缀和主要响应结构：

- `GET /api/v1/health`
- `POST /api/v1/llm/test`
- `POST /api/v1/pipeline/chapter-preview`
- `POST /api/v1/pipeline/run`
- `POST /api/v1/pipeline/jobs`
- `GET /api/v1/pipeline/jobs`
- `GET /api/v1/pipeline/jobs/{job_id}`
- `GET /api/v1/pipeline/jobs/{job_id}/logs`
- `POST /api/v1/pipeline/jobs/{job_id}/frontend-result`
- `GET /api/v1/pipeline/jobs/{job_id}/frontend-result`

## Vercel 部署注意

1. 在 Vercel Project Settings 中配置 `.env.example` 里的 LLM 和 pipeline 环境变量。
2. `app/api/v1/pipeline/jobs/route.ts` 与 `/pipeline/run` 已设置 `maxDuration = 800`；具体可用时长仍取决于 Vercel 账号/计划限制。
3. Vercel 环境默认把 job 文件写到 `/tmp/tts-pipeline-data`，适合演示和短期轮询，不是持久化数据库。如果要长期保存任务结果，建议后续接入 Vercel Blob、KV、Postgres 或对象存储。
4. 当前任务式接口使用 Next.js `after()` 在返回 job id 后继续执行后台 pipeline；超长文本/大量 LLM 请求仍可能受函数最长执行时间影响。

## 校验

```bash
npm run typecheck
npm run build
```

本次重构已经通过上述检查，并用 `LLM_PROVIDER=mock` 验证了 `/api/v1/health` 与 `/api/v1/pipeline/jobs` 可以返回 completed job。
