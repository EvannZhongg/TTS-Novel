/**
 * Phase 3 验收: 通过真实 HTTP 走通完整闭环, 并验证并发/归属/结果回写。
 *
 * 需要 dev server 已在 localhost:3000 运行, 且 .env 配好真实 LLM。
 * 用法: npm run verify:e2e
 *
 * 样本用 test_txt/ 下的真实小说文本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const TXT_DIR = path.join(process.cwd(), '..', 'test_txt');
const EMAIL = `e2e-${Date.now()}@test.local`;

let fail = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); fail += 1; };
const check = (cond, m) => (cond ? ok : bad)(m);

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

/** 反复调 process-next 直到队列空; 返回处理过的任务摘要 */
async function drain(label, { concurrency = 1, maxRounds = 60 } = {}) {
  const done = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => api('POST', '/api/app/process-next', {})),
    );
    const claimed = batch.flatMap((r) => r.json.processed ?? []);
    if (!claimed.length) break;
    for (const item of claimed) {
      done.push(item);
      const tag = item.status === 'succeeded' ? '✓' : item.status === 'retrying' ? '↻' : '✗';
      console.log(`    ${tag} ${item.kind}${item.detail?.chapter_index ? ` #${item.detail.chapter_index}` : ''} ${item.durationMs ?? '?'}ms${item.message ? ` — ${item.message.slice(0, 70)}` : ''}`);
    }
  }
  console.log(`    [${label}] 共处理 ${done.length} 个任务`);
  return done;
}

// ------------------------------------------------------------------ 0. 健康
console.log('\n[0] health');
{
  const { json } = await api('GET', '/api/v1/health');
  check(json.db === 'ok', `db=${json.db}`);
  check(Boolean(json.llm_model), `llm=${json.llm_provider}/${json.llm_model}`);
}

// ------------------------------------------------------------------ 1. session
console.log('\n[1] session 幂等');
{
  const a = await api('POST', '/api/app/session', { email: EMAIL });
  const b = await api('POST', '/api/app/session', { email: EMAIL.toUpperCase() });
  check(a.status === 200 && Boolean(a.json.user_id), `创建用户 ${a.json.user_id?.slice(0, 8)}`);
  check(a.json.user_id === b.json.user_id, '大小写不同的同一邮箱返回同一 user_id(幂等)');
  const badEmail = await api('POST', '/api/app/session', { email: 'not-an-email' });
  check(badEmail.status === 400, `非法邮箱返回 400(实际 ${badEmail.status})`);
}

// -------------------------------------------------- 2. 逐章项目(chunk1 + chunk2)
console.log('\n[2] 逐章上传项目');
let perChapterId;
let preservedChapterId;
{
  const c1 = fs.readFileSync(path.join(TXT_DIR, 'chunk1.txt'), 'utf8');
  const c2 = fs.readFileSync(path.join(TXT_DIR, 'chunk2.txt'), 'utf8');
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL,
    title: '逐章测试',
    source_mode: 'per_chapter',
    chapters: [{ title: '第1章 穿越成妃', text: c1 }, { title: '第2章 受伤的火哥儿', text: c2 }],
  });
  check(created.status === 200, `建项 ${created.status} ${created.status !== 200 ? JSON.stringify(created.json) : ''}`);
  check(created.json.chapters_total === 2, `chapters_total=${created.json.chapters_total}`);
  perChapterId = created.json.project_id;

  // 并发驱动: 6 个并发打 2 章项目, 验证不会重复领取同一任务
  console.log('  并发驱动(6 并发):');
  const processed = await drain('per_chapter', { concurrency: 6 });
  const chapterJobs = processed.filter((p) => p.kind === 'chapter');
  const uniqueChapters = new Set(chapterJobs.map((p) => p.chapterId));
  check(chapterJobs.length === uniqueChapters.size, `${chapterJobs.length} 个章节任务 / ${uniqueChapters.size} 个不同章节 —— 无重复领取`);
  check(processed.filter((p) => p.kind === 'aggregate').length === 1, '恰好 1 个聚合任务');

  const prog = await api('GET', `/api/app/projects/${perChapterId}?email=${encodeURIComponent(EMAIL)}`);
  check(prog.json.project?.status === 'completed', `项目状态=${prog.json.project?.status}`);
  check(prog.json.project?.chapters_done === 2, `chapters_done=${prog.json.project?.chapters_done}`);
  check((prog.json.chapters ?? []).every((c) => c.status === 'succeeded'), '所有章节 succeeded');
  // 关键: 聚合必须把 enriched 结果回写, 否则 UI 上对白没有角色/声线
  check((prog.json.chapters ?? []).every((c) => c.enriched), '所有章节 enriched=true(聚合已回写)');

  // 已完成项目继续追加；request_id 重放不得重复创建。
  preservedChapterId = prog.json.chapters?.[0]?.id;
  const requestId = randomUUID();
  const c3 = '苏晚卿推开窗，低声说道：“今日继续赶路。”\n\n门外的人应了一声：“是。”';
  const appended = await api('POST', `/api/app/projects/${perChapterId}/chapters`, {
    email: EMAIL,
    request_id: requestId,
    chapters: [{ title: '第3章 继续赶路', text: c3 }],
  });
  check(appended.status === 200 && appended.json.start_index === 3, `追加范围从 #${appended.json.start_index} 开始`);
  const replay = await api('POST', `/api/app/projects/${perChapterId}/chapters`, {
    email: EMAIL,
    request_id: requestId,
    chapters: [{ title: '第3章 继续赶路', text: c3 }],
  });
  check(replay.json.idempotent === true && replay.json.chapters_total === 3, '追加请求重放幂等，总章节仍为 3');
  const duplicate = await api('POST', `/api/app/projects/${perChapterId}/chapters`, {
    email: EMAIL,
    request_id: randomUUID(),
    chapters: [{ title: '重复章节', text: c3 }],
  });
  check(duplicate.status === 400, `相同正文的新请求被拒绝 ${duplicate.status}`);

  console.log('  处理追加章节:');
  const appendedTasks = await drain('append', { concurrency: 3 });
  check(appendedTasks.filter((p) => p.kind === 'chapter').length === 1, '追加批次只处理 1 个新章节');
  check(appendedTasks.filter((p) => p.kind === 'aggregate').length === 1, '追加后重算 1 次全书聚合');
  const afterAppend = await api('GET', `/api/app/projects/${perChapterId}?email=${encodeURIComponent(EMAIL)}`);
  check(afterAppend.json.project?.chapters_total === 3, `追加后 chapters_total=${afterAppend.json.project?.chapters_total}`);
  check(afterAppend.json.project?.content_revision === 2, `content_revision=${afterAppend.json.project?.content_revision}`);
  check(afterAppend.json.project?.aggregated_revision === 2, `aggregated_revision=${afterAppend.json.project?.aggregated_revision}`);
  check(afterAppend.json.project?.aggregate_status === 'clean', `aggregate_status=${afterAppend.json.project?.aggregate_status}`);
}

// ------------------------------------------ 3. 结果内容(角色/声线/TTS 必须存在)
console.log('\n[3] 结果内容');
{
  const res = await api('GET', `/api/app/projects/${perChapterId}/result?email=${encodeURIComponent(EMAIL)}`);
  const book = res.json.book_result ?? {};
  check((book.role_registry ?? []).length > 0, `role_registry 有 ${book.role_registry?.length} 个角色`);
  check((book.aliases ?? []).length > 0, `aliases 有 ${book.aliases?.length} 项`);
  check((book.tts_segment_summary?.segment_count ?? 0) > 0, `tts_segment_summary.segment_count=${book.tts_segment_summary?.segment_count}`);
  const names = (book.role_registry ?? []).map((r) => r.canonical_name);
  check(names.some((n) => String(n).includes('元卿凌')), `识别出主角: ${names.join('/')}`);

  const chapters = await api('GET', `/api/app/projects/${perChapterId}/chapters?email=${encodeURIComponent(EMAIL)}`);
  const first = chapters.json.chapters?.find((chapter) => chapter.id === preservedChapterId) ?? chapters.json.chapters?.[0];
  const detail = await api('GET', `/api/app/projects/${perChapterId}/chapters/${first.id}?email=${encodeURIComponent(EMAIL)}`);
  const spans = (detail.json.chapter?.result?.chunks ?? []).flatMap((c) => c.final_grounded_dialogue_spans ?? []);
  check(spans.length > 0, `第 1 章有 ${spans.length} 个对白 span`);
  const withRole = spans.filter((s) => s.role_id && s.voice_profile?.description);
  check(withRole.length > 0, `其中 ${withRole.length} 个已绑定 role_id + voice_profile`);
  if (spans.length && !withRole.length) {
    bad('span 全部缺少 role_id/voice_profile —— 聚合结果没回写到 chapters.result!');
  }
  const ttsCount = (detail.json.chapter?.result?.tts_segments ?? []).length;
  check(ttsCount > 0, `第 1 章有 ${ttsCount} 个 TTS segment`);
  check(Boolean(detail.json.chapter?.result?.chunks?.[0]?.llm_result), '再次聚合后完整 llm_result 仍保留(未被 digest 覆盖)');
}

// ---------------------------------------------------------- 4. 归属隔离
console.log('\n[4] 归属隔离');
{
  const other = `other-${Date.now()}@test.local`;
  await api('POST', '/api/app/session', { email: other });
  const peek = await api('GET', `/api/app/projects/${perChapterId}?email=${encodeURIComponent(other)}`);
  check(peek.status === 404, `他人访问返回 ${peek.status}(必须 404 —— 用 403 会确认项目存在)`);
  const noEmail = await api('GET', `/api/app/projects/${perChapterId}`);
  check(noEmail.status === 400, `不带邮箱返回 ${noEmail.status}(应 400)`);
  const ghost = await api('GET', `/api/app/projects/${perChapterId}?email=ghost-${Date.now()}@test.local`);
  check(ghost.status === 404, `未登记邮箱返回 ${ghost.status}(应 404)`);
}

// ------------------------------------------------------- 5. 整本上传(后台拆章)
console.log('\n[5] 整本上传 + 后台拆章');
{
  const full = fs.readFileSync(path.join(TXT_DIR, '医妃倾天下.txt'), 'utf8');
  const cut = full.indexOf('第4章');
  const text = cut > 0 ? full.slice(0, cut) : full;
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL, title: '医妃倾天下(前3章)', source_mode: 'whole_book', text,
  });
  check(created.json.status === 'chapterizing', `建项后状态=${created.json.status}(应 chapterizing)`);
  const pid = created.json.project_id;

  const processed = await drain('whole_book', { concurrency: 3 });
  check(processed.some((p) => p.kind === 'chapterize'), '执行了拆章任务');
  check(processed.filter((p) => p.kind === 'aggregate').length === 1, '恰好 1 个聚合任务');

  const prog = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  check(prog.json.project?.status === 'completed', `项目状态=${prog.json.project?.status}`);
  check((prog.json.project?.chapters_total ?? 0) >= 3, `拆出 ${prog.json.project?.chapters_total} 章`);
  check((prog.json.chapters ?? []).every((c) => c.enriched), '所有章节 enriched=true');
  console.log(`    章节: ${(prog.json.chapters ?? []).map((c) => `${c.chapter_index}.${c.title}(${c.char_count}字/${c.duration_ms}ms)`).join(', ')}`);

  const result = await api('GET', `/api/app/projects/${pid}/result?email=${encodeURIComponent(EMAIL)}`);
  check(Boolean(result.json.book_result), '全书聚合摘要可读取');
}

// ------------------------------------------------------------------ 6. 反馈
console.log('\n[6] 反馈');
{
  const fb = await api('POST', '/api/app/feedback', {
    email: EMAIL, project_id: perChapterId, category: 'split_quality', comment: 'e2e 自动化反馈',
  });
  check(fb.status === 200 && Boolean(fb.json.feedback_id), `反馈已记录 ${fb.json.feedback_id?.slice(0, 8)}`);
  const empty = await api('POST', '/api/app/feedback', { email: EMAIL });
  check(empty.status === 400, `空反馈返回 400(实际 ${empty.status})`);
}

// -------------------------------------------------------- 7. 空队列不报错
console.log('\n[7] 空队列');
{
  const idle = await api('POST', '/api/app/process-next', {});
  check(idle.status === 200 && idle.json.claimed === false, '空队列返回 claimed=false');
}


// ------------------------- 8. 输入退化: 无章节标题的文本应有兜底而非失败
console.log('\n[8] 无章节标题的输入');
{
  // Chapterizer.split 对没有任何标题的文本会返回一个 "正文" 兜底章节,
  // 所以这类输入应当正常完成而不是失败 —— 这是刻意的健壮性行为。
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL, title: '无标题文本', source_mode: 'whole_book',
    text: '她推开门，屋里一片漆黑。\n\n“有人吗？”她轻声问。\n\n没有人回应，只有风声。',
  });
  const pid = created.json.project_id;
  await drain('no_title', { concurrency: 2 });
  const prog = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  check(prog.json.project?.status === 'completed', `无标题文本项目状态=${prog.json.project?.status}(应 completed, 有兜底章节)`);
  check(prog.json.project?.chapters_total === 1, `兜底为 ${prog.json.project?.chapters_total} 章`);
}

// ---------------------------- 9. 重试接口(对没有失败章节的项目应安全返回)
console.log('\n[9] 重试接口');
{
  const r = await api('POST', `/api/app/projects/${perChapterId}/retry`, { email: EMAIL });
  check(r.status === 200 && r.json.requeued === 0, `无失败章节时 requeued=${r.json.requeued}(应 0 且不报错)`);
}

// ---------------------------------------------------- 10. 删除接口与归属校验
console.log('\n[10] 删除项目');
{
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL,
    title: '待删除项目',
    source_mode: 'per_chapter',
    chapters: [{ title: '测试章节', text: '“测试对白。”' }],
  });
  const pid = created.json.project_id;
  const other = `delete-other-${Date.now()}@test.local`;
  await api('POST', '/api/app/session', { email: other });

  const forbidden = await api('DELETE', `/api/app/projects/${pid}?email=${encodeURIComponent(other)}`);
  check(forbidden.status === 404, `他人删除返回 ${forbidden.status}(应 404)`);

  const deleted = await api('DELETE', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  check(deleted.status === 200 && deleted.json.deleted === true, `本人删除返回 ${deleted.status}`);

  const gone = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  check(gone.status === 404, `删除后项目返回 ${gone.status}(应 404)`);
}

console.log(fail === 0 ? '\n✅ Phase 3 端到端全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
