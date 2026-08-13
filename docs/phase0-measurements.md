# Phase 0 实测结论

测试环境:自造 40 章中文小说(5.6 万字 / 0.16MB),`.env` 里的 deepseek-v4-flash,本地 dev。

## 1. 结果体积:14× 膨胀,必须分章存

| 项 | 实测 |
|---|---|
| 原文 → result JSON 膨胀比 | **91 bytes / 原文字**(排除前言章) |
| 单章 result | **85–93 KB**(约 1000 字/章) |
| `chapters` 占全书 result | **85%** |
| mock 跑 40 章全书 | 0.16MB 输入 → **2.28MB** 输出 |

外推真实中文网文:

| 规模 | 单章 result | 全书 chapters 总量 |
|---|---|---|
| 30 万字 / 150 章 | ~178 KB | **26 MB** |
| 100 万字 / 400 章 | ~223 KB | **87 MB** |
| 300 万字 / 1200 章 | ~223 KB | **261 MB** |

**结论**:单章 200KB 存 jsonb 完全没问题(Postgres TOAST 上限 ~1GB)。但**全书 `book_result` 不能存完整 chapters**——几十到几百 MB 的 jsonb 查询会很慢。`book_result` 只存全书级聚合(aliases / role_registry / tts_segment_summary),完整章节内容永远只从 `chapters.result` 按需取。

## 2. 聚合任务不能读全书完整结果 → 用 digest

原计划担心的 `statement_timeout` 风险是真的:400 章 × 223KB = 87MB,一次读完不可行。

但实测三个全书级函数(`mergeAliasesFromChapters` / `buildRoleProfileInputs` / `bindRoleRegistryToFinalSpans` + `buildTtsSegmentsForChapters`)只需要:
`chapter.{chapter_id,title,aliases,cleaned_text}` + `chunks[].{chunk_id,start,end,final_grounded_dialogue_spans}`,且 span 只用到约 20 个字段。

| | 体积 | 400 章外推 |
|---|---|---|
| 完整 chapter | 179 KB(2章) | 87 MB |
| **digest** | **35 KB(2章)** | **17 MB** |

**决策**:`chapters` 表加一列 `digest jsonb`,章节任务完成时同时写 `result`(完整,给用户结果页)和 `digest`(精简,给聚合)。聚合任务**只读 digest 列**。17MB 可以在一次调用里处理完。

## 3. 耗时:35s/章 → 整本必须分章(印证核心决策)

实测 2 个约 1000 字的章节 **70 秒**(约 35s/章,含 grounding 与引号补抽)。

| 规模 | 串行 | 3 并发 |
|---|---|---|
| 150 章 | 88 分钟 | **29 分钟** |
| 400 章 | 233 分钟 | **78 分钟** |

`maxDuration=300`(5 分钟)最多跑 8 章。**整本同步跑必然超时**,章节级队列不是优化而是唯一可行方案。同时说明:单章 35s 远低于 300s,单章任务安全;但**极端长章**(单章上万字 → 多 chunk × 每 chunk 一次 LLM)有超时风险,worker 需记录单章耗时,超过阈值告警。

## 4. 未验证项(需你确认)

- **Vercel 计划**:cron 分钟级需 Pro,Hobby 只有天级;`maxDuration=300` 在 Hobby 某些配置下被压到 60s。若被压到 60s,单章 35s 的余量就很薄,需要下调 chunk 并发或拆到 chunk 级任务。
- 上述外推基于自造文本(对白密度较高、句式规整)。真实小说对白密度更低,实际体积应**小于**外推值,可当上界看。

## 5. 计划修正

| 原计划 | 改为 |
|---|---|
| `projects.book_result` 存全书聚合 | 保留,但**只存全书级摘要**,不含 chapters |
| 聚合任务读所有 `chapters.result` | 改为**只读新增的 `chapters.digest` 列** |
| (无) | `chapters` 表新增 `digest jsonb` 列 |

## 6. 已修正的错误认知

`MockLLMClient` **是完整实现的**(`llm.ts:154-214`),此前判断为"引用但未实现"是错的,`createLLMClient` 走 mock 分支不会崩。但它 `dialogue_spans` 返回空数组(`llm.ts:212`),所以:

**mock 基准只能覆盖拆章 + 聚合骨架,完全不经过 span 抽取和 grounding**——而这恰恰是最复杂的代码。Phase 2 的等价性验证必须用**真实 LLM 录制的响应回放**(record/replay),不能只靠 mock,否则 600 行 grounding 逻辑改坏了也测不出来。已有 `/tmp/nm/real2.json` 作为真实响应样本起点。

---

# Phase 2 结论:等价性已验证

## 验证方法(与原计划的重要修正)

原计划打算用 `LLM_PROVIDER=mock` 做等价性基准。**这个方案不成立**:
`MockLLMClient` 的 `dialogue_spans` 恒为空数组(`llm.ts:212`),于是 span 抽取、
source grounding、引号补抽、声线绑定、TTS 切分**全都不会执行**——恰好是最复杂、
最容易在重构中改坏的部分。

改为 **cassette 录制/回放**(`src/server/tts/cassette.ts`):
用真实 deepseek 跑一遍并按 prompt 哈希存盘,之后离线回放,既确定性又覆盖全路径。

```
npm run verify:equivalence -- --record   # 首次录制(需真实 LLM)
npm run verify:equivalence               # 离线回放比对
```

样本:`test_txt/医妃倾天下.txt` 前两章(2367 字,15 个 span,32 个 TTS segment)。

## 结果

`runMinimal` 与「chapterize → chapter×N → aggregate」两条路径产出**逐字节一致**:
aliases / role_registry / tts_segments / tts_segment_summary /
chapter_title_detection / preprocessing / 各章 tts_segments 全部深度一致。
`runMinimal` 与录制基准一致(77043 字节)。

**这条基准是后续重构的护栏**,Phase 3 / Phase 5 结束时必须重跑。

## 踩过的两个坑(已修复,避免重犯)

1. **stage 内部自建 runner 会绕过注入的 LLM client。**
   `runChapterizeStage` 等函数内部 `new PipelineRunner(...)`,最初没有把
   `llmOverride` 传进去,于是路径 B 直连了真实 LLM。表现为 `voice_profile` 的
   confidence/description 有差异,看起来像 digest 丢字段,实际是模型随机性。
   已给三个 stage 都加上 `llmOverride` 形参。

2. **cassette 允许覆盖会污染录制。**
   两条路径请求同一 prompt 时,后写覆盖先写,于是各自拿到模型对同一 prompt 的
   不同回答,比对全是噪声。已改为 record 模式下同 key **只写一次**。

诊断过程中已确认:`buildChapterDigest` 产出的 role profile 输入与完整章节结果
**完全一致**(证据字符数、span 数、prompt 全部逐字相同),digest 设计是正确的。

## 顺带清理

`runMinimal` 里那份 pipeline 配置回显原本写了两遍(进度快照 + 最终返回),
改动一处就会静默漂移。已抽成 `pipelineConfigSnapshot()`
(放在 `runnerHelpers.ts` 而非 `stages.ts`——后者依赖 runner,反向引用会成环)。

---

# Phase 1 结论:schema 已应用并验证

## 连接方式(重要,别再踩)

直连主机 `db.<ref>.supabase.co` **只有 IPv6 记录**,本地无 IPv6 出口时必然
`ENOTFOUND`。必须用 pooler:

```env
SUPABASE_DB_HOST=aws-0-ap-southeast-2.pooler.supabase.com
SUPABASE_DB_PORT=5432          # session mode，支持事务/DDL
SUPABASE_DB_USER=postgres.jdoplgnnrvejkvfbqoon   # 注意带 project ref 后缀
```

端口 **6543 是 transaction mode,不能跑迁移**(不支持 DDL 所需的事务语义),
迁移一律用 5432。

命令:`npm run db:probe`(探端点) / `npm run migrate` / `npm run verify:schema`。

## 踩到的一个真实事故:revoke 把 service_role 也收权了

0001 原本写了:
```sql
revoke all on all tables in schema public from anon, authenticated;
```
意图是让 publishable key 读写被拒。实测执行后 **service_role 也丢了
SELECT/INSERT/UPDATE/DELETE**,只剩 REFERENCES/TRIGGER/TRUNCATE ——
服务端用 secret key 同样读不到任何表,整个应用不可用。

`npm run verify:schema` 的第 6 项("secret key 可读 projects")抓到了它。
如果没有这条断言,这个问题会一直潜伏到 Phase 3 写 worker 时才爆发,
而且表现为"查询返回空"而不是报错,很难定位。

**修复**:0003 显式把完整 DML 授回 service_role 并设 default privileges;
同时删掉 0001/0002 里的 revoke 语句(避免全新部署重现)。

**正确的隔离方式**:只靠 RLS。所有表 `enable row level security` 且
**不建任何 policy**,anon/authenticated 天然一行都读不到,不需要动表权限。

## 验收结果(npm run verify:schema)

- 7 张表 + 关键列(`chapters.digest` / `enriched` / `duration_ms` 等)齐全
- 4 个防重复唯一索引 + `jobs_claimable_idx` 就位
- 7 张表 RLS 全开且 policy 数为 0
- anon 读写均 `permission denied`;secret key 可读
- **竞态测试通过**:两章先后完成 → 恰好 1 个 aggregate;重复完成幂等
  (`chapters_done` 不重复递增,aggregate 不重复创建)
- `claim_next_job` 领取后 status=running / attempts=1 / lease 已设

应用侧 `GET /api/v1/health` 返回 `"db":"ok"`。

---

# Phase 3 结论:队列闭环已跑通

## 验收命令

```
npm run verify:schema       # schema/RLS/竞态/重试(不需要 dev server)
npm run verify:equivalence   # Phase 2 等价性护栏(离线回放)
npm run verify:e2e           # 真实 HTTP 全链路(需 dev server + 真实 LLM)
npm run verify:failure       # 失败与重试路径(自起独立实例, 需先停 3000)
```

`verify:failure` 会自己起一个 LLM 指向死端点的实例。Next **不允许同目录同时跑
两个 dev server**, 所以跑它之前要先停掉 3000 端口的实例。

## 实测结果

整本上传:`chapterize 3.9s → 3 章并行(27/47/37s) → aggregate 11s → completed`。
逐章上传:2 章 + 聚合。两种模式的 `enriched` 全部为 true, span 带 `role_id` 与
`voice_profile`,角色识别出「元卿凌/宇文皓/其嬷嬷」。

**并发正确性**:6 个并发 `process-next` 打 2 章项目 —— 章节任务数与不同章节数
相等(无重复领取),聚合任务恰好 1 个。

**失败路径**:LLM 指向死端点 → 每章重试到上限 → 章节 `failed` 且记录 error →
项目落终态(不永久卡在 processing)→ 重试接口回退 `chapters_failed` 并重新排队。

## 修掉的两个真实缺陷

**1. 重试后项目永久卡死(0004)。**
原 `finish_chapter_job` 用 `where not exists (... kind='aggregate')` 判断是否建
聚合任务。重试场景下,上一轮那个已 `succeeded` 的聚合会永久阻止新聚合被创建,
于是重试成功的章节结果永远进不了全书聚合,项目卡在 `partially_failed`。
同时 `chapters_failed` 没人回退,`done+failed` 会超过 `total`。
修法:判断条件改为只看 `pending/running`;新增 `requeue_failed_chapters()`
在锁住 project 行的同一临界区里复位章节状态并回退计数。

**2. 靠匹配错误文案推断 HTTP 状态码。**
`handleRoute` 原来用正则匹配 message 决定 400/500,导致 "not found: 项目不存在"
被判成 500 而非 404。改为 `ApiError` 类显式携带状态码(`badRequest`/`notFound`),
并单独处理 `ZodError`。归属越权现在稳定返回 **404 而非 403** ——
403 会确认"该项目存在"。

## 一个被证伪的假设

我原以为"没有章节标题的文本会让拆章失败"。实测不会:`Chapterizer.split`
对无标题文本返回一个「正文」兜底章节(text.ts),流程正常完成。
原来的测试断言写错了,已改为验证兜底行为本身。

## 逐章模式:不做任何标题拆分

按你的要求,逐章上传**不解析、不识别、不校验标题**:
- `title` 只是可选展示标签,缺省自动编号「第N章」
- 不从正文里提取标题,也不跑 LLM 标题校验(那只属于整本拆章)
- title **不拼进正文** —— 拼进去会污染 pipeline 输入和对白 span 偏移
- `runChapterStage` → `processChapter` 里 title 仅作为 prompt 上下文和日志

## 顺带修掉的生产陷阱

`next.config.ts` 的 `outputFileTracingIncludes` 原来只匹配 `/api/v1/**`,
而 worker 在 `/api/app/process-next` 里调 `renderPrompt()` 读 prompts/*.md。
线上会抛 ENOENT 而本地 dev 因为直读文件系统永远是绿的。已改为 `/api/**`。

---

# LLM 调用日志(0005)

## 最重要的发现:token 用量此前被完全丢弃

`llm.ts` 的 `chat()` 解析完响应后只读 `choices[0].message.content`,
**`usage` 字段(prompt_tokens / completion_tokens)直接被扔掉**。
对付费 API 来说这是最有价值的观测数据,而且捕获它零成本。

现在已捕获。实测单章(约 1150 字)约 **12800 tokens**(3 次调用)。

## 记录粒度:全部记指标,仅失败记详情

体量实测(约 3.5 次调用/章):

| | 单行体积 | 100 用户 × 400 章 |
|---|---|---|
| 成功(仅指标) | **160 bytes** | — |
| 失败(带片段) | 3.6 KB | — |
| 全量存 prompt+响应 | ~4.4 KB | 603 MB |
| 当前方案 | 混合 | **约 27 MB** |

表结构见 `supabase/migrations/0005_llm_calls.sql`,含 `llm_usage_by_project`
视图(供 Dashboard 直接查成本与失败率)与 `prune_logs()`(14 天保留)。

接口:`GET /api/app/projects/[id]/usage` 返回用量 + 最近失败记录。

## 架构约束:client 不碰数据库

LLM client 通过 `LLMMetricSink` 回调上报指标,**自己不写库**。
落库发生在 `worker.ts` 的 collector 里。这样 `stages.ts` 仍是零 DB 依赖的纯函数,
将来那个 `{key, text}` 对外接口可以直接复用。

`purpose` 走 `LLMJsonRequest.purpose` 独立字段, **不能塞进 `extra`** ——
`extra` 会被 spread 进上游请求体(`chat()` 里的 `...request.extra`),
放进去会改变发给 LLM 的实际请求, 也会污染 cassette 的 prompt 指纹。

## 三个在验证中发现并修掉的缺陷

**1. 失败的 LLM 日志会丢。**
最初 collector 在每个 job 函数内部创建、结束时 flush。任务抛异常时 flush 永远
不执行 —— 而失败的调用日志恰恰是最需要的那部分。已把 collector 生命周期上移到
`processNextJob`, 用 `finally` 保证 flush。

**2. prompt 片段存了开头, 等于什么都没存。**
prompt 的结构是「约 2500 字静态模板 + 末尾 `{{payload_json}}`」——
输入数据在 **99%** 处。存开头 2000 字只会存到一堆与本次调用无关的固定说明,
4.5KB/行 的排障价值为零。已改为取**尾部**(`tailExcerpt`),现在片段里能看到
实际的小说正文与 `known_aliases` 等输入。

**3. verify:failure 泄漏子进程。**
`child.kill()` 只杀掉 npx 包装进程, 真正的 next-server 变成孤儿继续占 3123 端口,
导致之后起 dev server 报 "Another next dev server is already running"。
已改为 `detached: true` + `process.kill(-pid)` 杀整个进程组。

## 验收

```
npm run verify:llm-logs   # 表内容、体积、视图、prune_logs
```
断言成功调用有 token 且无 prompt 片段、失败调用必有 error 与片段。

---

# Phase 4 结论:前端已拆为精简多页面

## 页面结构

```
/                                   项目列表 + 邮箱入口(含隐私提示)
/projects/new                       新建(整本 / 逐章两种模式)
/projects/[id]                      进度 + 章节列表 + 失败重试按钮 + token 用量
/projects/[id]/chapters/[cid]       结果(角色/声线/对白序列/原文高亮)+ 反馈
```

## 结果页可视化取舍

旧的 `/debug` 页面、`public/debug.js`、整本 full-result 拼装接口和项目原文读取接口
已经移除。章节结果页只提供两种展示:

- 结构化列表:角色、情绪、对白与旁白
- 原文高亮:直接使用单章 `tts_segments.start/end` 在 `cleaned_text` 中高亮对白句

不再展示章节地图、chunk inspector、候选标题、运行日志和坐标校验等内部组件。

## 移除的功能

导入 JSON、章节标题候选筛选表、健康检查按钮、内部运行日志、坐标校验视图，
以及 localStorage 存结果(结果现在落库,localStorage 只存邮箱)。

## 修掉的一个真实缺陷

**首页服务端渲染成空白。** 我最初写了 `if (!ready) return <main className="page" />`
来避免"已登录用户看到一帧邮箱表单",但 `ready` 只在 `useEffect` 里置为 true,
于是服务端渲染出的是**完全空的页面** —— 用户会看到一瞬白屏,禁用 JS 时更是
什么都没有。`verify:ui` 的 HTML 断言抓到了它(首页 HTML 长度 10515 但可见文本为空)。
修法:默认就渲染邮箱入口(它对未登记用户本就是正确首屏),只在确实读到邮箱时
才切换到项目列表。

## 验收

```
npm run verify:ui     # 页面渲染 + 章节页数据契约 + 原文高亮偏移
```

实测通过项包括:未给 title 时自动编号为「第N章」、`speaker` 能匹配到
`role_registry`(宇文皓/元卿凌/其嬷嬷)、用量卡片有 token 数，
旧 `/debug` 路由返回 404，对白具备可视化需要的 start/end 偏移。

另外单独核实过:**15/15 个 span 文本都能在原文中定位**,
且 chunk 拼接结果与 `cleaned_text` 逐字相同(2/2 章)——
这是原文高亮能够准确覆盖对白句的前提。

---

# Phase 5 结论:旧管道已拆除

## 删除清单

| 文件 | 原因 |
|---|---|
| `app/api/v1/pipeline/**`(6 个路由) | run / jobs×4 / chapter-preview 全部由 `/api/app/*` 取代 |
| `src/server/tts/service.ts` | 那个内存 `Map` 是本次重构要解决的核心 bug |
| `src/server/tts/jobStore.ts` | 文件系统 job store, Vercel 上 `/tmp` 不共享也不持久 |
| `prompts/__init__.py` + `__pycache__/` | Python 时代的残留 |
| `AppSettings.dataDir` / `APP_DATA_DIR` | 文件存储已不存在 |
| `PipelineSettings.rulesFallbackEnabled` | 载入但从未被任何代码读取 |
| `http.ts` 里 3 个 schema | 只有已删除的旧路由在用 |

**保留 `runMinimal`** —— 它不再有任何路由暴露, 但 `verify:equivalence`
用它作等价性基准。删掉它就等于拆掉了唯一能证明"重构没改坏算法"的护栏。

`/api/v1/llm/test` 保留并**加了 `ADMIN_TOKEN` 保护** —— 它会用服务端 API key
真实调用模型花钱, 之前是完全不设防的。未配置 ADMIN_TOKEN 时直接拒绝,
避免"忘记配置就等于开放"。

## 一处我说错了的地方(已更正)

我之前把 `next.config.ts` 的 `outputFileTracingIncludes` 只匹配 `/api/v1/**`
称为"只在线上炸的陷阱", 并断言 worker 会因为读不到 prompt 而抛 ENOENT。

**实测证伪**:临时把配置改回 `/api/v1/**` 重新 build, 检查
`.next/server/app/api/app/process-next/route.js.nft.json` ——
5 个 prompt `.md` **依然全部被追踪进去了**。原因是 `renderPrompt()` 里
`path.join(process.cwd(), 'src/server/tts/prompts', filename)`(llm.ts:306)
的目录部分是静态字符串, Next 的 tracer 能自动识别。

改成 `/api/**` 仍然有价值(把依赖显式声明出来, 且一旦将来 filename 变成
完全动态的变量、自动推断失效时它仍然有效), 但那不是"修了一个线上 bug"。
注释已改为准确描述。

## 最终验收(六条全绿)

```
npm run verify:schema        表/索引/RLS/竞态/重试
npm run verify:equivalence   三阶段组合 == runMinimal(逐字节)
npm run verify:ui            页面渲染 + 脚本隔离 + 数据契约
npm run verify:e2e           真实 HTTP 全链路
npm run verify:llm-logs      LLM 日志内容与体积
npm run verify:failure       失败与重试路径
```

另外核实:旧 pipeline 路由全部返回 404;`llm/test` 无 token 返回 401;
`health` 正常返回 `db: ok`。

---

# 故障复盘:推理模型的 max_tokens 陷阱

## 症状

第20章反复失败, 三次重试全挂:
```
error=LLMJsonParseError: LLM JSON response parse failed: Unexpected end of JSON input
[llm] failed response preview is empty
```
另有若干章报 `Unterminated string`。

## 根因

`deepseek-v4-flash` 是**推理模型**: 思维链放在 `message.reasoning_content`,
而 **`max_tokens` 同时约束推理与正文**。推理吃光预算时:
`finish_reason='length'`, `content=''` —— 空字符串丢给 `JSON.parse`
就得到 "Unexpected end of JSON input", 完全看不出真正原因。

实测(7 个真实章节样本, dialogue span 抽取):

| | reasoning tokens | completion 总量 |
|---|---|---|
| 最小 | 1304 | 1907 |
| 中位 | 3328 | 3669 |
| **最大** | **6652** | **7895** |

原配置 `LLM_MAX_OUTPUT_TOKENS=8192` —— 相对最大观测值 7895 只有 **4% 余量**。
稍复杂的章节(人物多、对白密)就会越界。两种报错其实是同一个原因:
推理阶段就耗尽 → 空内容; 推理留下一点余量但正文写不完 → JSON 被截断。

## 修复

1. `LLM_MAX_OUTPUT_TOKENS` **8192 → 32768**(约 4x 最大观测值)。
   `.env` / `.env.example` / `config.ts` 默认值同步, 并写清原因。
2. 新增 `LLMEmptyContentError` / `LLMTruncatedContentError`, 在
   `chat()` 里显式识别 `finish_reason='length'` 并给出可读诊断
   (含实际 reasoning token 数与当前 max_tokens), 不再让空串流到 JSON.parse。
3. **这两类错误不重试** —— 同样的预算重试三次只会同样耗尽,
   白花三倍的钱和 30-40s/次的时间。

## 过程中发现的自身缺陷

修复初版把"不重试"的 `throw` 放在了 `emitMetric()` **之前**,
导致预算类失败完全不进 `llm_calls` 表 —— 而那恰恰是最需要被记录的失败。
已调整顺序, 并加断言:预算失败必须上报 1 条 status=failed 的指标且带 prompt 片段。

## 一点自省

这个签名我在本次会话最早的连通性测试里就见过
(`content:""`, `finish_reason:"length"`, `reasoning_content` 有内容),
当时只关注了"HTTP 200 说明 LLM 可用"就放过了。如果那时追一句,
可以省掉后面这次线上故障。**验证时看到反常数据要当场追问, 不要只看结论。**
