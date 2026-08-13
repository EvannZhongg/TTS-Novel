/**
 * Phase 4 前端验收(无浏览器环境, 用 HTTP + HTML 断言代替)。
 *
 * 验证:
 *   1. 各用户页面可渲染，旧调试页与脚本已移除
 *   2. 走完真实流程(建项 → 驱动 → 完成), 章节页能拿到渲染所需的全部字段
 *   3. 章节页具备原文高亮所需的文本和 start/end 偏移
 *
 * 用法: npm run verify:ui  (需 dev server 在 3000)
 */
import fs from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const TXT_DIR = path.join(process.cwd(), '..', 'test_txt');
const EMAIL = `ui-${Date.now()}@test.local`;

let fail = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); fail += 1; };
const check = (cond, m) => (cond ? ok : bad)(m);

async function html(url) {
  const res = await fetch(`${BASE}${url}`);
  return { status: res.status, body: await res.text() };
}
async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

// -------------------------------------------------------- 1. 页面可渲染
console.log('\n[1] 页面渲染');
{
  const home = await html('/');
  check(home.status === 200, `/ → ${home.status}`);
  check(home.body.includes('用邮箱开始') || home.body.includes('我的项目'), '首页含邮箱入口或项目列表');
  check(/不做验证|非私密|不要上传敏感/.test(home.body), '首页有隐私提示(邮箱未验证必须告知)');

  const create = await html('/projects/new');
  check(create.status === 200, `/projects/new → ${create.status}`);
  check(create.body.includes('整本上传') && create.body.includes('逐章上传'), '新建页有两种上传模式');

  const dbg = await html('/debug/00000000-0000-0000-0000-000000000000');
  check(dbg.status === 404, `旧 /debug/[id] 已移除 → ${dbg.status}`);
}

// -------------------------------------------------------- 2. 真实流程
console.log('\n[2] 真实流程(逐章上传 2 章)');
let projectId;
{
  const c1 = fs.readFileSync(path.join(TXT_DIR, 'chunk1.txt'), 'utf8');
  const c2 = fs.readFileSync(path.join(TXT_DIR, 'chunk2.txt'), 'utf8');
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL, title: 'UI 验收', source_mode: 'per_chapter',
    // 刻意不给 title, 验证自动编号
    chapters: [{ text: c1 }, { text: c2 }],
  });
  check(created.status === 200, `建项 ${created.status}`);
  projectId = created.json.project_id;

  // 模拟项目页的队列驱动
  for (let i = 0; i < 30; i += 1) {
    const batch = await Promise.all([0, 1, 2].map(() => api('POST', '/api/app/process-next', {})));
    if (!batch.some((r) => r.json.claimed)) break;
  }
  const prog = await api('GET', `/api/app/projects/${projectId}?email=${encodeURIComponent(EMAIL)}`);
  check(prog.json.project?.status === 'completed', `项目完成 status=${prog.json.project?.status}`);
  check(prog.json.project?.content_revision === 1, `content_revision=${prog.json.project?.content_revision}`);
  check(prog.json.project?.aggregated_revision === 1, `aggregated_revision=${prog.json.project?.aggregated_revision}`);
  check(prog.json.project?.aggregate_status === 'clean', `aggregate_status=${prog.json.project?.aggregate_status}`);
  const titles = (prog.json.chapters ?? []).map((c) => c.title);
  check(titles.every((t) => /^第\d+章$/.test(t)), `未给 title 时自动编号: ${titles.join(', ')}`);
}

// ------------------------------------------ 3. 章节页渲染所需字段齐全
console.log('\n[3] 章节结果页所需数据');
{
  const list = await api('GET', `/api/app/projects/${projectId}/chapters?email=${encodeURIComponent(EMAIL)}`);
  const first = list.json.chapters[0];
  const detail = await api('GET', `/api/app/projects/${projectId}/chapters/${first.id}?email=${encodeURIComponent(EMAIL)}`);
  const chapter = detail.json.chapter;
  check(Boolean(chapter), '取到章节');
  check(chapter.enriched === true, 'enriched=true(聚合已回写角色与声线)');

  // 页面主要靠 tts_segments 渲染对白/旁白序列
  const segs = chapter.result?.tts_segments ?? [];
  check(segs.length > 0, `tts_segments ${segs.length} 个`);
  const dialogues = segs.filter((s) => s.type === 'dialogue');
  check(dialogues.length > 0, `其中对白 ${dialogues.length} 句`);
  check(dialogues.every((s) => s.text), '每句对白都有 text');
  check(dialogues.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start), '对白带可视化 start/end 偏移');
  check(dialogues.some((s) => s.speaker), '对白带 speaker');
  check(dialogues.some((s) => s.emotion), '对白带 emotion');
  check(segs.some((s) => s.type === 'narration'), '含旁白 segment');
  check(typeof chapter.result?.cleaned_text === 'string' && chapter.result.cleaned_text.length > 0, '章节含原文高亮使用的 cleaned_text');
  check(Boolean(chapter.result?.chunks?.[0]?.llm_result), '聚合后完整 llm_result 仍保留');

  // 声线来自 book_result.role_registry
  const book = await api('GET', `/api/app/projects/${projectId}/result?email=${encodeURIComponent(EMAIL)}`);
  const roles = book.json.book_result?.role_registry ?? [];
  check(roles.length > 0, `role_registry ${roles.length} 个角色`);
  check(roles.every((r) => r.canonical_name), '角色都有 canonical_name');
  check(roles.some((r) => r.voice_profile?.description), '角色带声线描述');
  // 章节页用 speaker 名字匹配 role_registry, 必须能对上
  const speakerNames = new Set(dialogues.map((s) => s.speaker).filter(Boolean));
  const roleNames = new Set(roles.map((r) => r.canonical_name));
  const matched = [...speakerNames].filter((n) => roleNames.has(n));
  check(matched.length > 0, `speaker 能匹配到 role_registry: ${matched.join('/')}`);

  // 用量卡片
  const usage = await api('GET', `/api/app/projects/${projectId}/usage?email=${encodeURIComponent(EMAIL)}`);
  check(Number(usage.json.usage?.total_tokens) > 0, `用量卡片有 token 数: ${usage.json.usage?.total_tokens}`);
}

console.log(fail === 0 ? '\n✅ Phase 4 前端验收通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
