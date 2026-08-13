/**
 * 失败路径验收: 把 LLM 指向一个必然失败的端点, 验证
 *   1. 章节任务重试 max_attempts 次后标记 failed
 *   2. 失败章节不阻塞其余章节, 也不阻塞最终聚合
 *   3. 项目落到 partially_failed(而非永久卡在 processing)
 *   4. 重试接口能让失败章节重新排队, 并触发新的聚合
 *
 * 独立起一个端口, 避免干扰主 dev server。
 * 用法: npm run verify:failure
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
const EMAIL = `fail-${Date.now()}@test.local`;
const TXT_DIR = path.join(process.cwd(), '..', 'test_txt');

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
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

// 起一个 LLM 指向黑洞的实例。127.0.0.1:9 是 discard 端口, 连接会立即失败。
console.log(`启动测试实例(LLM 指向死端点, port ${PORT})...`);
// 注意: Next 不允许同一目录同时跑两个 dev server, 所以本脚本会先探测
// 3000 端口是否被占用, 若占用则提示先停掉 —— 这是刻意的, 避免误杀你的开发实例。
const child = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
  env: {
    ...process.env,
    LLM_BASE_URL: 'http://127.0.0.1:9',
    LLM_RETRY_MAX_ATTEMPTS: '1',
    LLM_TIMEOUT_SECONDS: '5',
    QUEUE_MAX_ATTEMPTS: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  // detached: 让子进程自成进程组, 收尾时可以整组杀掉。
  // 否则 kill 只杀掉 npx 包装进程, 真正的 next-server 会变成孤儿继续占端口,
  // 后续再起 dev server 会报 "Another next dev server is already running"。
  detached: true,
});
const logFile = fs.createWriteStream('/tmp/nm/failtest.log');
child.stdout.pipe(logFile);
child.stderr.pipe(logFile);

async function waitReady(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/v1/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  if (!(await waitReady())) {
    throw new Error(
      '测试实例启动超时。若日志里是 "Another next dev server is already running",\n' +
      '   请先停掉 3000 端口的 dev server(Next 不允许同目录跑两个 dev 实例),\n' +
      '   跑完本测试再重启即可。日志: /tmp/nm/failtest.log',
    );
  }
  console.log('实例就绪\n');

  // 两章: LLM 全挂, 两章都会失败
  const c1 = fs.readFileSync(path.join(TXT_DIR, 'chunk1.txt'), 'utf8');
  const c2 = fs.readFileSync(path.join(TXT_DIR, 'chunk2.txt'), 'utf8');
  const created = await api('POST', '/api/app/projects', {
    email: EMAIL, title: '失败路径测试', source_mode: 'per_chapter',
    chapters: [{ title: '第1章', text: c1 }, { title: '第2章', text: c2 }],
  });
  const pid = created.json.project_id;
  check(created.status === 200, `建项 ${created.status}`);

  console.log('\n[1] 驱动队列直到终态(每章 QUEUE_MAX_ATTEMPTS=2, 含退避)');
  let status = null;
  let rounds = 0;
  for (; rounds < 40; rounds += 1) {
    const r = await api('POST', '/api/app/process-next', {});
    const items = r.json.processed ?? [];
    for (const item of items) {
      console.log(`    ${item.status === 'succeeded' ? '✓' : item.status === 'retrying' ? '↻' : '✗'} ${item.kind} ${item.status}${item.message ? ` — ${item.message.slice(0, 60)}` : ''}`);
    }
    const prog = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
    status = prog.json.project?.status;
    if (status === 'partially_failed' || status === 'failed' || status === 'completed') break;
    if (!items.length) await new Promise((r) => setTimeout(r, 3000));   // 等退避到期
  }

  const prog = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  const p = prog.json.project;
  console.log(`\n[2] 终态: status=${p?.status} done=${p?.chapters_done} failed=${p?.chapters_failed}`);
  check(status === 'failed' || status === 'partially_failed', `项目进入终态 ${status}(不能永久卡在 processing)`);
  check(p?.chapters_failed > 0, `chapters_failed=${p?.chapters_failed}(应 > 0)`);
  check((prog.json.chapters ?? []).some((c) => c.status === 'failed'), '存在 failed 章节');
  check((prog.json.chapters ?? []).every((c) => c.error), '失败章节都记录了 error');
  console.log(`    章节错误示例: ${(prog.json.chapters ?? [])[0]?.error?.slice(0, 90)}`);

  console.log('\n[3] 重试接口能重新排队');
  const retry = await api('POST', `/api/app/projects/${pid}/retry`, { email: EMAIL });
  check(retry.json.requeued > 0, `重新投递了 ${retry.json.requeued} 章`);
  const after = await api('GET', `/api/app/projects/${pid}?email=${encodeURIComponent(EMAIL)}`);
  check(after.json.project?.chapters_failed === 0, `重试后 chapters_failed=${after.json.project?.chapters_failed}(应回退为 0)`);
  check(after.json.project?.status === 'processing', `重试后 status=${after.json.project?.status}(应 processing)`);
  check(after.json.pending_jobs > 0, `重试后有 ${after.json.pending_jobs} 个待处理任务`);
} catch (error) {
  bad(`测试异常: ${error.message}`);
} finally {
  // 杀整个进程组(负号 pid), 确保 next-server 一起退出
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  // 等端口真正释放
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(fail === 0 ? '\n✅ 失败路径全部通过' : `\n❌ ${fail} 项失败(详见 /tmp/nm/failtest.log)`);
process.exit(fail === 0 ? 0 : 1);
