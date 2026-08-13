// 核实 llm_calls 表的实际内容: 成功只存指标、失败带片段、prune_logs 可用。
import dns from 'node:dns';
import { Client } from 'pg';
import nextEnv from '@next/env';

dns.setDefaultResultOrder('ipv6first');
nextEnv.loadEnvConfig(process.cwd());

const c = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

let fail = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); fail += 1; };
const check = (cond, m) => (cond ? ok : bad)(m);

console.log('\n[1] 总览');
const total = (await c.query('select count(*)::int as n from llm_calls')).rows[0].n;
console.log(`  llm_calls 共 ${total} 行`);
check(total > 0, '有记录');

console.log('\n[2] 按 purpose 分组');
const byPurpose = (await c.query(`
  select purpose, status, count(*)::int as n,
         sum(coalesce(total_tokens,0))::int as tokens,
         round(avg(duration_ms))::int as avg_ms
    from llm_calls group by 1,2 order by 1,2`)).rows;
byPurpose.forEach((r) => console.log(`  ${r.purpose.padEnd(32)} ${r.status.padEnd(7)} n=${String(r.n).padStart(3)} tokens=${String(r.tokens).padStart(7)} avg=${r.avg_ms}ms`));
check(byPurpose.some((r) => r.purpose !== 'unknown'), 'purpose 已正确分类(不是 unknown)');

console.log('\n[3] 成功调用: 应有 token、不应有 prompt/响应片段');
const okRows = (await c.query(`
  select count(*)::int as n,
         count(*) filter (where total_tokens is not null)::int as with_tokens,
         count(*) filter (where prompt_excerpt is not null)::int as with_prompt,
         count(*) filter (where error is not null)::int as with_error
    from llm_calls where status='ok'`)).rows[0];
console.log(`  成功 ${okRows.n} 行: 带token ${okRows.with_tokens}, 带prompt片段 ${okRows.with_prompt}, 带error ${okRows.with_error}`);
check(okRows.n === 0 || okRows.with_tokens > 0, '成功调用捕获了 token 用量(此前被丢弃)');
check(okRows.with_prompt === 0, '成功调用未存 prompt 片段(省空间)');
check(okRows.with_error === 0, '成功调用无 error');

console.log('\n[4] 失败调用: 应有 error + 片段(排障必需)');
const failRows = (await c.query(`
  select count(*)::int as n,
         count(*) filter (where error is not null)::int as with_error,
         count(*) filter (where prompt_excerpt is not null)::int as with_prompt
    from llm_calls where status='failed'`)).rows[0];
console.log(`  失败 ${failRows.n} 行: 带error ${failRows.with_error}, 带prompt片段 ${failRows.with_prompt}`);
if (failRows.n === 0) {
  console.log('  (本次无失败记录 —— 先跑 npm run verify:failure 再看这一项)');
} else {
  check(failRows.with_error === failRows.n, '所有失败都记了 error');
  check(failRows.with_prompt === failRows.n, '所有失败都记了 prompt 片段');
  const sample = (await c.query(`
    select purpose, attempt, error, left(prompt_excerpt, 60) as p
      from llm_calls where status='failed' order by id desc limit 3`)).rows;
  sample.forEach((r) => console.log(`    ${r.purpose} attempt=${r.attempt} error=${String(r.error).slice(0, 40)} prompt="${String(r.p).replace(/\n/g, ' ')}..."`));
}

console.log('\n[5] 每行平均体积(验证体量估算)');
const size = (await c.query(`
  select round(avg(pg_column_size(t)))::int as avg_bytes
    from (select * from llm_calls) t`)).rows[0];
console.log(`  平均 ${size.avg_bytes} bytes/行`);
check(size.avg_bytes < 6000, `平均行大小 ${size.avg_bytes} bytes(全量存 prompt 会是数千, 这里应偏小)`);

console.log('\n[6] 用量视图');
const view = (await c.query('select * from llm_usage_by_project order by total_tokens desc limit 3')).rows;
view.forEach((r) => console.log(`  project ${String(r.project_id).slice(0, 8)}: calls=${r.calls} failed=${r.failed_calls} tokens=${r.total_tokens}`));
check(view.length > 0, 'llm_usage_by_project 视图可查');

console.log('\n[7] prune_logs(用 0 天保留期做干跑, 随后回滚)');
await c.query('begin');
try {
  const pruned = (await c.query('select prune_logs(0) as r')).rows[0].r;
  console.log(`  ${JSON.stringify(pruned)}`);
  check(typeof pruned.llm_calls_deleted === 'number', 'prune_logs 返回删除计数');
} finally {
  await c.query('rollback');
  console.log('  已回滚, 数据未真删');
}

await c.end();
console.log(fail === 0 ? '\n✅ LLM 日志验收通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
