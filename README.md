# 多播电子书测试系统

面向中文小说的**章节拆分 + 多角色对白抽取**服务。把小说文本转成结构化的章节、
对白、角色、声线和 TTS segment 数据。

当前形态是一个 Next.js 应用:面向用户的 demo(收集拆分质量反馈)+ 内部 API。
数据落 Supabase Postgres。

## 架构要点

### 为什么是章节级任务队列

实测数据(见 `docs/phase0-measurements.md`):

| 指标 | 实测值 |
|---|---|
| 单章处理耗时 | **约 35s**(约 1150 字/章,含 grounding 与引号补抽) |
| 原文 → 结果膨胀 | **91 bytes / 原文字** |
| 单章结果 JSON | 85–223 KB |
| 400 章长篇串行 | 233 分钟(3 并发约 78 分钟) |

Vercel 函数上限 300s **最多只能跑 8 章**,所以整本同步处理必然超时。
方案是把每章做成一个独立任务:

```
建项目 → [chapterize 任务] → [chapter 任务 × N] → [aggregate 任务] → 完成
```

状态全在 Postgres 里,所以刷新页面、换设备、关掉再打开都能续跑。

### 三个阶段与纯函数约束

`src/server/tts/stages.ts` 暴露三个阶段:

| 阶段 | 作用 |
|---|---|
| `runChapterizeStage` | 正则找标题候选 → LLM 校验 → 拆章 |
| `runChapterStage` | 单章完整分析(复用 `runner.processChapter`) |
| `runAggregateStage` | 全书 aliases / 声线 profile / TTS segment |

> **`stages.ts` 必须保持零 DB 依赖。** 所有数据库读写都在
> `src/server/queue/worker.ts`。这样后续对外 API(输入 `{key, text}` 单章文本 →
> 返回拆分结果)可以直接调 `runChapterStage`,一行 DB 代码都不需要。

`runMinimal`(整本一次跑完)保留下来**专门作为等价性基准**,不再有路由暴露它。

### 并发正确性在数据库层

两个竞态必须由 Postgres 函数保证,不能靠应用层判断
(见 `supabase/migrations/0002_functions.sql`):

- **原子领任务** —— `claim_next_job` 用 `for update skip locked`,
  并发调用各自领到不同任务
- **"谁是最后一章"** —— `finish_chapter_job` 先锁 project 行,
  把"递增计数"和"判断是否最后一个"放进同一临界区。
  两章同时完成时既不会建出两个聚合,也不会一个都不建

### 数据存储取舍

- 小说原文单独存 `project_sources` 表 —— 列项目时不会拖出几 MB 全文
- 每章存两份结果:`result`(完整,给用户结果页)+ `digest`(约 20%,只给聚合)。
  聚合只读 digest:400 章长篇完整数据 87MB → digest 17MB
- `projects.book_result` **只存全书级摘要**,绝不含完整章节

### 安全模型

- 浏览器**永不直连 Supabase**,一律走 `/api/app/*`,服务端用 secret key
- 所有表开 RLS 且**不建任何 policy** → anon key 一行都读不到
- **邮箱即凭据且未经验证** —— 任何人填同一邮箱都能看到该邮箱下的项目。
  这是刻意的 demo 取舍(零摩擦、可跨设备恢复),前端已明示"非私密"

## 页面

```
/                                项目列表 + 邮箱入口
/projects/new                    新建(整本上传 / 逐章上传)
/projects/[id]                   进度 + 章节列表 + 失败重试 + token 用量
/projects/[id]/chapters/[cid]    结果(角色/声线/对白/原文高亮)+ 反馈
```

章节结果支持在「结构化列表」和「原文高亮」之间切换。高亮只使用单章结果中
已有的 `tts_segments.start/end`，不提供额外的内部调试组件。

**整本上传** 会在后台拆章(含 LLM 标题校验)。
**逐章上传** 是可持续追加的连载项目，不做任何标题拆分 —— `title` 只是可选
展示标签，缺省自动编号。项目创建后可在详情页继续批量选择 TXT 或粘贴章节，
新章节从当前末尾连续编号并立即进入处理队列。

### 持续追加与结果版本

逐章项目不是一次性任务。数据库用以下字段区分“正文最新版本”和“全书结果版本”：

- `projects.content_revision`：每次追加或重试失败章节时递增
- `projects.aggregated_revision`：当前已发布的全书角色/声线结果版本
- `projects.aggregate_status`：`clean / dirty / running / failed`
- `jobs.target_revision`：章节或聚合任务针对的正文版本

上传批次通过 `append_chapter_batch()` 原子完成序号分配、章节插入、项目计数、
版本递增和任务创建。客户端为每批提供 `request_id`，相同请求重放不会重复创建
章节；正文 SHA-256 相同的新请求会被判定为重复章节。

聚合任务带版本栅栏：如果聚合运行期间又追加了章节，旧任务可以完成计算，但
不能覆盖最新 `book_result`，系统会在所有新章节终结后补建最新版本聚合。

单章的完整 `chapters.result` 保持不可变。全书聚合新增的角色绑定、声线与
`tts_segments` 写入独立的 `chapters.enrichment`，读取章节时再合并，避免过去
用精简 digest 覆盖完整结果的问题。

聚合回写按 25 章一批调用 `save_chapter_enrichment_batch()`，400 章长篇从约
400 次逐章数据库往返降为约 16 次批量往返。

## API

### 内部(供 demo 前端,邮箱凭据)

```
POST /api/app/session                            登记/识别邮箱
GET  /api/app/projects?email=                    项目列表
POST /api/app/projects                           新建(whole_book / per_chapter)
GET  /api/app/projects/[id]                      进度 + 章节列表
DELETE /api/app/projects/[id]?email=             删除项目及全部关联内容
POST /api/app/projects/[id]/chapters             逐章项目追加章节（request_id 幂等）
GET  /api/app/projects/[id]/chapters/[cid]       单章完整结果
GET  /api/app/projects/[id]/result               全书聚合摘要
GET  /api/app/projects/[id]/usage                token 用量 + 失败记录
POST /api/app/projects/[id]/retry                重试失败章节
POST /api/app/process-next                       领并处理一个任务(队列驱动)
POST /api/app/feedback                           用户反馈
```

### 运维

```
GET  /api/v1/health      服务 + DB 探活
POST /api/v1/llm/test    LLM 连通性(需 x-admin-token)
```

`/api/v1` 命名空间的其余部分留给将来的对外服务(单章进 → 结果出,
形态待与 TTS 一起设计)。

## 本地运行

```bash
npm install
cp .env.example .env      # 填 SUPABASE_* 与 LLM_*
npm run migrate           # 应用数据库迁移
npm run dev
```

### 数据库连接

Supabase 直连主机 `db.<ref>.supabase.co` **只有 IPv6 记录**,本地无 IPv6 出口
时会 `ENOTFOUND`。改用 pooler(**端口 5432 session mode**,6543 的
transaction mode 不支持迁移所需的事务语义):

```env
SUPABASE_DB_HOST=aws-0-<region>.pooler.supabase.com
SUPABASE_DB_PORT=5432
SUPABASE_DB_USER=postgres.<project-ref>
SUPABASE_DB_PASSWORD=...
```

`npm run db:probe` 会自动探测可用端点并打印该写进 `.env` 的配置。

## 验收脚本

```bash
npm run typecheck
npm run build

npm run verify:schema        # 表/索引/RLS/竞态/重试路径(不需要 dev server)
npm run verify:equivalence   # 等价性基准: 三阶段组合 == 旧 runMinimal(离线回放)
npm run verify:ui            # 页面渲染 + 脚本隔离 + 数据契约(需 dev server)
npm run verify:e2e           # 真实 HTTP 全链路(需 dev server + 真实 LLM)
npm run verify:llm-logs      # LLM 日志表内容与体积
npm run verify:failure       # 失败与重试路径(自起实例, 需先停 3000 端口)
```

### 等价性基准是核心护栏

`verify:equivalence` 用 **cassette 录制真实 LLM 响应后离线回放**,证明
「三阶段组合」与旧 `runMinimal` 产出**逐字节一致**。

不要改用 `LLM_PROVIDER=mock` 做这个基准 —— `MockLLMClient` 的
`dialogue_spans` 恒为空数组,span 抽取 / grounding / 引号补抽 / 声线绑定
全都不会执行,而那恰恰是最容易改坏的部分。

首次需要录制(会真实调用 LLM):

```bash
npm run verify:equivalence -- --record
```

## 环境变量

关键项:

```env
# Supabase(运行时)
SUPABASE_URL=
SUPABASE_SECRET_KEY=          # 服务端专用, 绕过 RLS
SUPABASE_PUBLISHABLE_KEY=     # 目前仅用于验收脚本断言 anon 被拒

# Supabase(仅本地迁移用, 不参与运行时)
SUPABASE_DB_HOST=
SUPABASE_DB_PORT=5432
SUPABASE_DB_USER=
SUPABASE_DB_PASSWORD=

# LLM(OpenAI 兼容)
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-v4-flash
LLM_TIMEOUT_SECONDS=120
LLM_RETRY_MAX_ATTEMPTS=3
LLM_LOG_FAILED_RESPONSE_CHARS=2000   # 失败时保存的 prompt/响应片段长度

# Pipeline(常用)
PIPELINE_CHUNK_MAX_CHARS=800
PIPELINE_MAX_PARALLEL_CHAPTERS=3
PIPELINE_GROUNDING_ENABLED=true
PIPELINE_QUOTE_SPAN_RECOVERY_ENABLED=true
PIPELINE_ROLE_VOICE_PROFILE_ENABLED=true

# 队列
QUEUE_LEASE_SECONDS=300              # 租约; 过期的 running 任务会被回收重投
QUEUE_MAX_ATTEMPTS=3
QUEUE_CHAPTER_SLOW_WARN_MS=120000    # 单章耗时告警阈值
QUEUE_MAX_TASKS_PER_REQUEST=1

# 运维
ADMIN_TOKEN=                         # /api/v1/llm/test 需要
```

## 已知限制

- **Vercel Hobby 的 cron 只有天级粒度**。当前队列靠前端页面驱动
  (项目页轮询时并发调用 `process-next`),用户关掉页面后进度会停在原处,
  下次打开继续。分钟级的无人值守推进需要 Pro 计划的 cron。
- 极端长章(单章上万字 → 多 chunk × 每 chunk 一次 LLM)有超时风险,
  worker 会记录 `duration_ms` 并在超阈值时告警,但暂未拆到 chunk 级任务。
- 日志表(`job_events` / `llm_calls`)保留 14 天,由 `prune_logs()` 清理,
  目前需要手动或由 cron 触发。
- 当前输出是 TTS 前处理的结构化数据,不生成音频。
