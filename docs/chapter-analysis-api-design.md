# NovelMind 章节拆解 API 设计

> 文档状态：Draft
> 目标版本：API v1
> 更新日期：2026-08-14

## 1. 文档目的

本文描述将 NovelMind 的章节拆解能力作为后端 API 服务提供时的接口与职责边界。

API 的目标使用方式是：

1. 客户在自己的后端保存小说、章节、角色、音色和处理结果。
2. 客户自己的后端负责章节上传顺序、任务调度、失败重试和结果入库。
3. NovelMind 接收单章原文以及客户当前保存的角色/音色上下文。
4. NovelMind 返回本章对白拆解、角色识别、音色总结，以及建议写入客户状态库的增量变更。

NovelMind 当前仓库中的页面、项目表、章节表和前端队列驱动只属于体验 Demo，
不作为正式 API 的数据模型或调用方式。

---

## 2. 核心设计原则

### 2.1 客户是业务数据的唯一事实来源

正式 API 不要求客户先在 NovelMind 创建“书籍项目”，也不依赖 NovelMind 长期保存：

- 小说全文
- 历史章节
- 全书角色库
- 角色与 Voice ID 的绑定
- 章节分析结果
- 客户的处理进度

以上数据由客户后端持久化。每次分析章节时，客户把本次处理所需的当前上下文发送给
NovelMind。

### 2.2 API 不做文本清洗

NovelMind 按客户提交的 `chapter.text` 原样分析：

- 不删除或替换空白
- 不统一标点
- 不转换简繁体
- 不修正错别字
- 不识别或移除章节标题
- 不把一章再次拆成多章
- 不返回“清洗后正文”

服务内部可以为了模型调用进行 Chunk 切分，但不能改变文本内容。所有 `start`、`end`
必须以客户提交的原始 `chapter.text` 为基准。

如果客户需要文本清洗，应由客户在调用 API 前完成，并自行保存清洗前后文本的映射。

### 2.3 API 是分析器，不是客户的工作流系统

NovelMind 提供异步分析任务，但不负责决定：

- 下一章何时上传
- 一本书允许多少章并发
- 哪个失败任务应该重试
- 处理结果何时发布给终端用户
- 人工修正是否接受
- 是否根据建议切换角色 Voice

这些决策由客户后端完成。

### 2.4 角色身份和 Voice 绑定必须跨章节稳定

同一本书中已经存在的角色必须由客户提供稳定的 `role_id`。NovelMind 在分析新章节时：

- 优先把本章人物匹配到已有 `role_id`
- 对无法匹配的新人物返回角色创建建议
- 对不确定人物返回歧义结果，而不是强制合并
- 已绑定 Voice 的角色默认继续使用原 `voice_id`

### 2.5 NovelMind 返回“建议补丁”，不直接修改客户状态

响应中的角色和 Voice 变更使用 `context_patch` 表示。客户收到结果后，应在自己的
数据库事务中检查版本并决定是否应用。

NovelMind 不认为一个补丁已经生效，直到客户自行保存。

---

## 3. 系统边界

```text
终端用户或内容运营
        │
        ▼
客户业务后端
  ├── 小说/章节存储
  ├── 角色库
  ├── Voice 库和绑定
  ├── 任务调度与重试
  ├── 结果版本控制
  └── 人工修正
        │
        │ HTTPS API
        ▼
NovelMind API
  ├── 单章对白抽取
  ├── 说话人和情绪识别
  ├── 原文区间定位
  ├── 已有角色匹配
  ├── 新角色发现
  ├── 角色音色总结
  ├── Voice 分配建议
  └── TTS Segment 结构生成
```

---

## 4. 双方职责划分

## 4.1 客户后端必须保存的数据

| 数据 | 是否必须 | 说明 |
|---|---:|---|
| `external_book_id` | 是 | 客户系统中的作品 ID |
| `external_chapter_id` | 是 | 客户系统中的稳定章节 ID |
| 章节原文 | 是 | NovelMind 不作为长期正文存储 |
| 章节内容 Hash | 是 | 判断章节是否发生变化 |
| 章节处理状态 | 是 | 未提交、处理中、成功、失败等 |
| NovelMind `job_id` | 是 | 用于轮询和排查任务 |
| 单章分析结果 | 是 | NovelMind 任务结果只建议短期保留 |
| 全书角色库 | 是 | 包含稳定 `role_id`、名称和别名 |
| 角色库版本 | 是 | 用于防止旧结果覆盖新状态 |
| 角色人工修正 | 是 | 改名、合并、拆分、别名修正 |
| Voice Catalog | 是 | 客户当前可以使用的真实 Voice ID |
| 角色与 Voice 的绑定 | 是 | 保证角色跨章节声音一致 |
| Voice 绑定版本 | 是 | 用于并发和发布控制 |
| Voice 锁定状态 | 是 | 已发布音频的角色不应被自动换声 |
| Narrator Voice | 建议 | 旁白通常使用固定 Voice |
| API 幂等键 | 是 | 安全重试同一次提交 |

### 客户角色库最小结构

```json
{
  "revision": 12,
  "roles": [
    {
      "role_id": "role-xiaojing",
      "canonical_name": "萧景",
      "aliases": ["景王", "王爷"],
      "gender": "male",
      "status": "confirmed",
      "summary": "皇族男性，主要角色",
      "voice_profile": {
        "description": "青年男性声线，低沉、克制",
        "age_group": "young_adult",
        "gender": "male",
        "confidence": 0.88,
        "version": 3
      }
    }
  ]
}
```

客户不需要在每次请求中发送历史章节全文。角色上下文应是经过压缩的结构化角色库。

## 4.2 客户后端负责的调度

客户负责：

1. 从自己的数据库读取待处理章节。
2. 读取这本书最新的角色库和 Voice 绑定。
3. 创建 NovelMind 分析任务。
4. 保存 `job_id`。
5. 通过轮询或 Webhook 等待完成。
6. 保存原始分析结果。
7. 检查返回补丁的 `base_revision`。
8. 在事务中应用角色和 Voice 补丁。
9. 更新客户自己的章节状态。
10. 失败时使用相同幂等键重试，或创建新一轮分析。

### 同一本书的并发要求

API v1 建议客户对同一本书的“角色解析和 Voice 分配”串行调度：

```text
读取角色上下文 v12
    ↓
处理第 10 章
    ↓
应用补丁，得到 v13
    ↓
使用 v13 处理第 11 章
```

不同书籍可以并行处理。

如果同一本书的多个章节同时基于 v12 分析，它们可能各自把同一个新人物判断为新角色。
客户可以并行保存对白抽取结果，但不能不经检查地并行应用所有 `context_patch`。

后续可增加独立的“重新对齐角色上下文”接口，支持提取并行、角色补丁串行。

## 4.3 NovelMind 提供的能力

NovelMind 对单章提供：

- 对白与旁白区间拆分
- 对白说话人识别
- 情绪总结
- 对白在原文中的精确位置
- 本章角色和稳定别名发现
- 与客户已有角色库的匹配
- 新角色候选
- 歧义角色候选
- 角色在本章体现出的音色特征
- 基于现有 Voice Catalog 的 Voice 分配建议
- 可直接供后续 TTS 使用的 Segment 列表

## 4.4 NovelMind 仅临时保存的数据

为了提供异步任务和稳定重试，NovelMind 可以临时保存：

- `job_id`
- 请求状态
- 幂等键与请求摘要
- 任务结果
- 错误信息
- 调用耗时和 Token 用量
- 必要的审计日志

这些数据只用于 API 运行，不构成客户业务数据的长期备份。

正式上线前需要在服务条款中明确：

- 请求正文保留时长
- 任务结果保留时长
- 日志是否包含正文片段
- 删除策略
- 数据所在地区

建议生产日志默认不记录完整章节正文和完整模型 Prompt。

---

## 5. 为什么请求需要携带角色和 Voice 上下文

API 服务本身不长期保存全书状态，因此第二章是否出现第一章已有角色，只能通过客户
发送的 `context` 判断。

例如第一章处理后，客户保存：

```json
{
  "role_id": "role-xiaojing",
  "canonical_name": "萧景",
  "aliases": ["景王", "王爷"],
  "voice_id": "voice_male_07"
}
```

第二章请求中出现“王爷”时，客户把该角色上下文发送给 NovelMind。NovelMind 应返回：

```json
{
  "detected_name": "王爷",
  "resolution": "matched_existing",
  "role_id": "role-xiaojing",
  "voice_id": "voice_male_07"
}
```

如果客户不发送已有角色库，NovelMind 只能把每一章当成独立文本，无法保证角色和
Voice 跨章节一致。

---

## 6. API 总览

正式 API 不提供 Demo 中的项目页面和浏览器驱动队列接口。

建议 v1 提供以下接口：

```text
POST   /v1/chapter-analysis-jobs
GET    /v1/chapter-analysis-jobs/{job_id}
POST   /v1/chapter-analysis-jobs/{job_id}/cancel
```

可选的后续接口：

```text
POST   /v1/chapter-reconciliation-jobs
GET    /v1/usage
GET    /v1/health
```

### 鉴权

```http
Authorization: Bearer nm_live_xxx
```

API Key 只能保存在客户后端，不能暴露给浏览器、小程序或移动 App。

---

## 7. 创建章节分析任务

```http
POST /v1/chapter-analysis-jobs
Authorization: Bearer nm_live_xxx
Idempotency-Key: 71f52b48-38ab-4b28-a578-b884f6aeb731
Content-Type: application/json
```

由于当前单章分析可能需要几十秒，v1 默认采用异步任务，不建议让客户保持长 HTTP
连接等待最终结果。

## 7.1 请求示例

```json
{
  "schema_version": "novelmind.chapter_analysis.request.v1",
  "request_id": "customer-request-20260814-0002",
  "book": {
    "external_book_id": "book-10086",
    "title": "医妃倾天下",
    "language": "zh-CN"
  },
  "chapter": {
    "external_chapter_id": "chapter-0002",
    "chapter_index": 2,
    "title": "初见王爷",
    "text": "夜色渐深。萧景看着她，问道：“你究竟是什么人？”",
    "text_sha256": "sha256:0a6e..."
  },
  "context": {
    "role_registry": {
      "revision": 12,
      "roles": [
        {
          "role_id": "role-xiaojing",
          "canonical_name": "萧景",
          "aliases": ["景王", "王爷"],
          "gender": "male",
          "status": "confirmed",
          "summary": "主要男性角色",
          "voice_profile": {
            "version": 3,
            "description": "青年男性声线，低沉、克制",
            "age_group": "young_adult",
            "gender": "male",
            "confidence": 0.88
          }
        }
      ]
    },
    "voice_context": {
      "revision": 5,
      "narrator_voice_id": "voice_narrator_01",
      "voices": [
        {
          "voice_id": "voice_male_07",
          "gender": "male",
          "age_group": "young_adult",
          "tags": ["低沉", "克制"],
          "enabled": true
        },
        {
          "voice_id": "voice_female_minor_01",
          "gender": "female",
          "age_group": "young_adult",
          "tags": ["清亮"],
          "enabled": true
        }
      ],
      "bindings": [
        {
          "role_id": "role-xiaojing",
          "voice_id": "voice_male_07",
          "mode": "dedicated",
          "locked": true
        }
      ]
    }
  },
  "voice_policy": {
    "allocate_for_new_roles": true,
    "keep_existing_binding": true,
    "allow_voice_reuse": true,
    "avoid_same_voice_in_same_chapter": true,
    "minor_role_strategy": "shared_by_gender_and_age",
    "when_exhausted": "return_unassigned"
  },
  "options": {
    "extract_dialogue": true,
    "detect_emotion": true,
    "summarize_voice": true,
    "generate_tts_segments": true
  },
  "callback": {
    "url": "https://customer.example.com/webhooks/novelmind",
    "events": ["chapter_analysis.succeeded", "chapter_analysis.failed"]
  },
  "metadata": {
    "customer_trace_id": "trace-abc-002"
  }
}
```

## 7.2 请求字段说明

### `book`

`book` 只提供当前分析需要的元数据，不表示 NovelMind 将创建或保存一本书。

| 字段 | 必须 | 说明 |
|---|---:|---|
| `external_book_id` | 是 | 客户稳定作品 ID |
| `title` | 建议 | 用于提高分析上下文准确度 |
| `language` | 是 | v1 建议使用 BCP 47，如 `zh-CN` |

### `chapter`

| 字段 | 必须 | 说明 |
|---|---:|---|
| `external_chapter_id` | 是 | 客户稳定章节 ID |
| `chapter_index` | 建议 | 客户侧章节顺序 |
| `title` | 否 | 纯元数据，不从正文提取 |
| `text` | 是 | 原样分析的完整单章正文 |
| `text_sha256` | 建议 | 客户计算的正文 Hash |

如果客户提交了 `text_sha256`，NovelMind 应重新计算并校验。不一致时返回 `400`。

### `context.role_registry`

客户当前已确认或暂定的角色库。

不建议发送无关的全量剧情、全部历史对白或全部历史章节。对于超长小说，可只发送：

- 高频角色
- 最近若干章出现的角色
- 别名可能与本章文本匹配的角色
- 人工锁定角色

如果客户裁剪了上下文，应保证所有可能在本章复现的重要角色仍在列表中。

### `context.voice_context`

`voice_id` 是客户或客户 TTS Provider 中的真实可用 ID。NovelMind 将其视为不透明
字符串，不自行创造真实 `voice_id`。

如果没有可用 Voice，客户可以：

- 传空 `voices`
- 设置 `allocate_for_new_roles=false`
- 只获取音色总结，不获取 Voice 分配建议

### `voice_policy`

| 字段 | 推荐默认值 | 说明 |
|---|---|---|
| `allocate_for_new_roles` | `true` | 是否给新角色建议 Voice |
| `keep_existing_binding` | `true` | 已有角色保留原 Voice |
| `allow_voice_reuse` | `true` | Voice 有限时是否允许共享 |
| `avoid_same_voice_in_same_chapter` | `true` | 同章对话角色尽量不同声 |
| `minor_role_strategy` | `shared_by_gender_and_age` | 低频角色共享策略 |
| `when_exhausted` | `return_unassigned` | Voice 不足时的行为 |

`when_exhausted` 建议支持：

```text
return_unassigned
reuse_best_match
use_fallback
```

使用 `use_fallback` 时，请求中还需提供 `fallback_voice_id`。

---

## 8. 创建任务响应

```http
HTTP/1.1 202 Accepted
```

```json
{
  "schema_version": "novelmind.job.v1",
  "job_id": "job_01K2R5M6J9T7",
  "request_id": "customer-request-20260814-0002",
  "status": "queued",
  "created_at": "2026-08-14T07:20:00Z",
  "status_url": "/v1/chapter-analysis-jobs/job_01K2R5M6J9T7"
}
```

服务端应以 `Idempotency-Key` 保证同一次业务提交安全重放。

### 幂等规则

相同 API Key 下：

- 相同 `Idempotency-Key` 和相同请求体：返回第一次创建的任务。
- 相同 `Idempotency-Key` 但请求体不同：返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 网络超时后，客户使用相同 Key 重试。
- 客户希望基于更新后的角色上下文重新分析时，必须使用新的 Key。

---

## 9. 查询任务

```http
GET /v1/chapter-analysis-jobs/{job_id}
Authorization: Bearer nm_live_xxx
```

处理中：

```json
{
  "job_id": "job_01K2R5M6J9T7",
  "status": "running",
  "stage": "role_resolution",
  "progress": 70,
  "attempt": 1,
  "created_at": "2026-08-14T07:20:00Z",
  "updated_at": "2026-08-14T07:20:31Z"
}
```

成功时，响应包含 `result`：

```json
{
  "job_id": "job_01K2R5M6J9T7",
  "status": "succeeded",
  "result": {
    "schema_version": "novelmind.chapter_analysis.result.v1",
    "request_id": "customer-request-20260814-0002",
    "external_book_id": "book-10086",
    "external_chapter_id": "chapter-0002",
    "source": {
      "text_sha256": "sha256:0a6e...",
      "char_count": 31,
      "offset_unit": "utf16_code_unit",
      "interval": "half_open"
    },
    "analysis": {
      "role_mentions": [],
      "dialogue_spans": [],
      "tts_segments": []
    },
    "context_patch": {
      "role_registry": {
        "base_revision": 12,
        "operations": []
      },
      "voice_context": {
        "base_revision": 5,
        "operations": []
      }
    },
    "warnings": []
  }
}
```

---

## 10. 分析结果结构

## 10.1 原文坐标

API v1 使用：

```json
{
  "offset_unit": "utf16_code_unit",
  "interval": "half_open"
}
```

即：

- `start` 包含在区间内
- `end` 不包含在区间内
- JavaScript 中应满足 `chapter.text.slice(start, end) === span.text`

这是因为当前 NovelMind 使用 TypeScript/JavaScript 字符串索引。后续如增加
`unicode_code_point` 或 `utf8_byte`，必须通过新的字段值明确声明，不能静默改变。

## 10.2 对白 Span

```json
{
  "span_id": "span_0002",
  "start": 14,
  "end": 24,
  "text": "你究竟是什么人？",
  "speaker": {
    "detected_name": "萧景",
    "resolution": "matched_existing",
    "role_id": "role-xiaojing",
    "confidence": 0.96
  },
  "emotion": {
    "label": "警惕",
    "confidence": 0.81
  },
  "grounding": {
    "status": "matched",
    "score": 1.0
  }
}
```

`resolution` 建议支持：

```text
matched_existing
proposed_new
ambiguous
unknown
```

## 10.3 新角色候选

NovelMind 可以为新角色生成 `proposed_role_id`，但该 ID 只有在客户接受并保存后才成为
客户角色库中的正式 ID。

```json
{
  "candidate_id": "candidate-qingzhu-01",
  "proposed_role_id": "role_01K2RNEW",
  "canonical_name": "青竹",
  "aliases": [],
  "gender": "female",
  "confidence": 0.83,
  "voice_profile_observation": {
    "description": "年轻女性声线，清亮、谨慎",
    "age_group": "young_adult",
    "gender": "female",
    "confidence": 0.67
  }
}
```

客户也可以忽略 `proposed_role_id`，使用自己的 ID 生成规则，并在保存结果时建立映射。

## 10.4 歧义角色

```json
{
  "detected_name": "殿下",
  "resolution": "ambiguous",
  "candidates": [
    {
      "role_id": "role-xiaojing",
      "confidence": 0.61
    },
    {
      "role_id": "role-xiaoyu",
      "confidence": 0.55
    }
  ],
  "needs_review": true
}
```

NovelMind 不应仅因为名称相同就自动合并低置信度角色。

## 10.5 TTS Segments

```json
[
  {
    "segment_id": "segment-001",
    "type": "narration",
    "start": 0,
    "end": 5,
    "text": "夜色渐深。",
    "role_id": null,
    "voice_id": "voice_narrator_01"
  },
  {
    "segment_id": "segment-002",
    "type": "dialogue",
    "start": 14,
    "end": 24,
    "text": "你究竟是什么人？",
    "role_id": "role-xiaojing",
    "voice_id": "voice_male_07",
    "emotion": "警惕"
  }
]
```

NovelMind 只返回结构和 Voice 选择，不在本 API 中生成音频。

---

## 11. Context Patch

## 11.1 角色补丁

```json
{
  "role_registry": {
    "base_revision": 12,
    "operations": [
      {
        "op": "add_alias",
        "role_id": "role-xiaojing",
        "alias": "景王殿下",
        "confidence": 0.91,
        "evidence": {
          "external_chapter_id": "chapter-0002",
          "span_id": "span_0002"
        }
      },
      {
        "op": "create_role",
        "proposed_role_id": "role_01K2RNEW",
        "role": {
          "canonical_name": "青竹",
          "aliases": [],
          "gender": "female",
          "status": "provisional"
        }
      },
      {
        "op": "update_voice_profile",
        "role_id": "role-xiaojing",
        "observation": {
          "description": "青年男性声线，低沉、克制，警觉时语气更短促",
          "age_group": "young_adult",
          "gender": "male",
          "confidence": 0.9
        }
      }
    ]
  }
}
```

角色操作建议支持：

```text
create_role
add_alias
remove_alias_suggestion
update_gender_observation
update_voice_profile
merge_role_suggestion
mark_ambiguous
```

`merge_role_suggestion` 只是建议，默认需要客户审核或高置信度规则确认。

## 11.2 Voice 补丁

```json
{
  "voice_context": {
    "base_revision": 5,
    "operations": [
      {
        "op": "bind_voice",
        "role_ref": "role_01K2RNEW",
        "voice_id": "voice_female_minor_01",
        "mode": "shared",
        "locked": false,
        "reason": "best profile match for a provisional minor role"
      }
    ]
  }
}
```

Voice 操作建议支持：

```text
bind_voice
keep_binding
mark_unassigned
suggest_rebinding
```

对于输入中 `locked=true` 的绑定，NovelMind 不得返回自动 `bind_voice` 覆盖它，只能返回
告警或人工调整建议。

## 11.3 客户应用补丁的事务要求

客户应用补丁前必须比较：

```text
当前角色库 revision == role_registry.base_revision
当前 Voice revision == voice_context.base_revision
```

如果不相等，说明任务使用的是旧上下文。客户应：

1. 保存不依赖上下文的对白抽取结果。
2. 暂不应用角色和 Voice 补丁。
3. 使用最新上下文重新执行角色对齐，或重新提交章节分析。

不能直接把旧补丁覆盖到新版本角色库中。

---

## 12. 有限 Voice ID 的处理规则

## 12.1 Voice ID 的所有权

- Voice Catalog 由客户保存。
- `voice_id` 由客户或客户的 TTS Provider 定义。
- NovelMind 只从请求提供的 Voice 中选择。
- NovelMind 不自行生成一个实际不可调用的 Voice ID。
- NovelMind 返回的是分配建议，最终绑定由客户保存。

## 12.2 已有角色

如果已有角色已经绑定 Voice：

```text
角色匹配成功
    ↓
保留已有 voice_id
    ↓
即使音色总结发生轻微变化也不自动换声
```

尤其当 `locked=true` 时，Voice 必须保持不变。

## 12.3 新角色

新角色分配顺序建议为：

1. 过滤语言、性别、年龄等明显不匹配的 Voice。
2. 匹配角色音色总结和 Voice 标签。
3. 尽量避免与本章主要对话角色使用同一 Voice。
4. 优先将稀缺独立 Voice 留给主要角色。
5. 低频角色允许按性别和年龄共享 Voice。
6. 无可用 Voice 时按 `when_exhausted` 返回。

## 12.4 Voice 不足

假设可用 Voice 只有 5 个，而书中出现了 30 个角色，客户应允许以下一种或多种策略：

- 主角独占 Voice
- 高频配角独占 Voice
- 低频角色共享 Voice
- 路人角色使用统一 Voice
- 暂不分配，等待人工处理

NovelMind 应在结果中明确分配模式：

```json
{
  "voice_id": "voice_female_minor_01",
  "mode": "shared",
  "reason": "minor_role_strategy",
  "locked": false
}
```

不能让客户误以为共享 Voice 是角色的独占 Voice。

---

## 13. Webhook

客户可以选择轮询，也可以提供 Webhook。

成功事件：

```json
{
  "event_id": "evt_01K2...",
  "event_type": "chapter_analysis.succeeded",
  "created_at": "2026-08-14T07:21:02Z",
  "data": {
    "job_id": "job_01K2R5M6J9T7",
    "request_id": "customer-request-20260814-0002",
    "external_book_id": "book-10086",
    "external_chapter_id": "chapter-0002"
  }
}
```

失败事件：

```json
{
  "event_id": "evt_01K2...",
  "event_type": "chapter_analysis.failed",
  "created_at": "2026-08-14T07:21:02Z",
  "data": {
    "job_id": "job_01K2R5M6J9T7",
    "error": {
      "code": "UPSTREAM_MODEL_TIMEOUT",
      "message": "章节分析暂时失败，可重试"
    }
  }
}
```

Webhook 要求：

- 使用签名头，例如 `NovelMind-Signature`
- 包含时间戳，防止重放
- 至少重试若干次并使用指数退避
- 客户根据 `event_id` 幂等消费
- Webhook 只通知状态，客户仍可通过 GET 获取权威结果

---

## 14. 错误结构

统一错误响应：

```json
{
  "error": {
    "code": "INVALID_ROLE_CONTEXT",
    "message": "role_id 在角色列表中重复",
    "request_id": "req_01K2...",
    "details": {
      "role_id": "role-xiaojing"
    }
  }
}
```

建议错误码：

| HTTP | Code | 场景 |
|---:|---|---|
| 400 | `INVALID_REQUEST` | 请求结构错误 |
| 400 | `TEXT_HASH_MISMATCH` | 正文 Hash 不一致 |
| 400 | `INVALID_ROLE_CONTEXT` | 角色上下文不合法 |
| 400 | `INVALID_VOICE_CONTEXT` | Voice 或绑定不合法 |
| 401 | `UNAUTHORIZED` | API Key 无效 |
| 403 | `FORBIDDEN` | 无权访问任务 |
| 404 | `JOB_NOT_FOUND` | 任务不存在或已过期 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同 Key 对应不同请求 |
| 413 | `CHAPTER_TOO_LARGE` | 单章超过限制 |
| 422 | `UNSUPPORTED_LANGUAGE` | 暂不支持该语言 |
| 429 | `RATE_LIMITED` | 超出并发或配额 |
| 500 | `INTERNAL_ERROR` | 内部错误 |
| 502 | `UPSTREAM_MODEL_ERROR` | 上游模型错误 |
| 504 | `UPSTREAM_MODEL_TIMEOUT` | 上游模型超时 |

---

## 15. 客户推荐存储模型

以下只是客户侧建议，不要求客户完全照搬：

```text
books
  external_book_id
  title
  role_registry_revision
  voice_context_revision

chapters
  external_chapter_id
  external_book_id
  chapter_index
  title
  text
  text_sha256
  analysis_status
  current_analysis_version

chapter_analysis_jobs
  request_id
  job_id
  idempotency_key
  role_base_revision
  voice_base_revision
  status
  error

chapter_analysis_results
  external_chapter_id
  analysis_version
  source_text_sha256
  result_json

roles
  role_id
  external_book_id
  canonical_name
  gender
  status
  voice_profile_json

role_aliases
  role_id
  alias
  confidence
  source_chapter_id

voices
  voice_id
  provider
  metadata_json
  enabled

role_voice_bindings
  role_id
  voice_id
  mode
  locked
```

---

## 16. 客户调用流程

```text
1. 客户保存或更新章节正文
2. 客户计算 text_sha256
3. 客户锁定该书的角色上下文调度槽
4. 客户读取最新角色库和 Voice 绑定
5. POST /v1/chapter-analysis-jobs
6. 客户保存 job_id、幂等键和 base revision
7. 客户轮询 GET，或等待 Webhook
8. 客户保存 analysis 原始结果
9. 客户检查 context_patch.base_revision
10. 客户事务性应用角色和 Voice 补丁
11. 客户递增自己的 revision
12. 客户标记章节完成
13. 客户释放调度槽并处理下一章
```

失败重试：

```text
HTTP 请求结果未知
  → 使用相同 Idempotency-Key 重试

任务明确失败且允许重试
  → 客户按退避策略重新创建任务

角色 base revision 已过期
  → 保留对白抽取结果，不应用旧补丁
  → 使用最新上下文重新对齐或重新分析
```

---

## 17. 与当前 NovelMind Demo 的关系

当前 Demo 中以下能力可以作为实现参考：

- `runChapterStage` 的单章对白分析
- Grounding
- 引号对白补抽
- 角色别名发现
- 角色音色 Profile 生成
- TTS Segment 构建
- 任务重试和幂等处理

正式 API 不应直接复用以下对外形态：

- 邮箱即凭据
- `/api/app/projects`
- Demo 的 Supabase 项目/章节数据作为客户权威数据
- 浏览器调用 `/api/app/process-next` 驱动队列
- 全书上传和自动拆章
- `content_revision`、`aggregated_revision` 由 NovelMind 替客户维护
- 占位 `voice_profile_id = "xxxx"`

正式实现应增加：

1. API Key 和 Tenant 隔离。
2. 新的 `/v1/chapter-analysis-jobs` 路由。
3. 不做文本清洗的章节分析入口。
4. 外部角色上下文输入。
5. 外部 Voice Catalog 和绑定输入。
6. 稳定的结果 Schema。
7. `context_patch` 输出。
8. API Worker，而不是浏览器驱动 Worker。
9. Webhook 签名和投递。
10. 请求与结果的明确保留策略。

---

## 18. v1 明确不包含的能力

- 小说全文托管
- 客户项目管理后台
- 整本自动拆章
- 文本清洗
- 章节标题识别
- 音频合成
- 音频文件存储
- 客户终端用户鉴权
- 角色头像、人物关系图等内容产品能力
- 自动永久修改客户的角色库
- 自动覆盖已锁定的 Voice 绑定

---

## 19. 后续可扩展接口

### 19.1 角色重新对齐

当客户并行分析多个章节或角色库发生人工修改时，可增加：

```http
POST /v1/chapter-reconciliation-jobs
```

输入：

- 已保存的单章对白抽取结果
- 最新角色库
- 最新 Voice Context

输出：

- 新的角色绑定
- 新的 `context_patch`
- 新的 TTS Segments

该接口不重新做对白抽取，可降低成本和耗时。

### 19.2 客户预配置 Voice Pool

如果客户 Voice Catalog 很大且变化很少，可以由客户预先在 NovelMind 配置一个只读的
Voice Pool，然后请求只传：

```json
{
  "voice_pool_ref": "customer-pool-v3"
}
```

但该模式会让 NovelMind 保存一部分客户配置。v1 推荐优先使用请求内传递的
`voice_context`，保持业务状态完全由客户管理。

---

## 20. 最终职责摘要

### 客户负责

- 保存正文和所有业务状态
- 调度章节
- 保证同书角色补丁的应用顺序
- 保存稳定 `role_id`
- 保存真实 Voice Catalog
- 保存并锁定 `role_id -> voice_id`
- 保存分析结果
- 决定是否接受角色、别名和 Voice 建议
- 处理人工修正

### NovelMind 负责

- 分析客户提交的原始章节文本
- 返回对白、说话人、情绪和原文坐标
- 基于客户提供的上下文匹配已有角色
- 发现新角色和歧义角色
- 总结角色音色
- 在客户提供的有限 Voice 中给出分配建议
- 返回 TTS Segment
- 提供异步任务、幂等、错误和可观测性

最核心的接口契约是：

```text
客户提交：
单章原文 + 当前角色上下文 + 当前 Voice 上下文

NovelMind 返回：
单章拆解结果 + 角色/Voice 增量建议

客户最终：
保存结果并决定如何更新自己的权威状态
```
