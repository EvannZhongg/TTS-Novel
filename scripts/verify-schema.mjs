// Phase 1 验收: 核实 schema、索引、RLS、以及两个并发正确性函数是否真的生效。
// 用法: node scripts/verify-schema.mjs
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';

dns.setDefaultResultOrder('ipv6first');
nextEnv.loadEnvConfig(process.cwd());

const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
await client.connect();

let fail = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => { console.log(`  FAIL ${msg}`); fail += 1; };

// -------------------------------------------------------------------- 1. 表
console.log('\n[1] 表');
const wantTables = [
  'demo_users', 'projects', 'project_sources', 'chapters',
  'chapter_upload_batches', 'jobs', 'job_events', 'feedback',
  'speaker_assignments', 'speaker_change_logs',
];
const tables = (await client.query("select tablename from pg_tables where schemaname='public'")).rows.map((r) => r.tablename);
for (const t of wantTables) (tables.includes(t) ? ok : bad)(`表 ${t}`);

// -------------------------------------------------------- 2. digest 列(Phase 0 结论)
console.log('\n[2] 关键列');
const cols = (await client.query(
  "select table_name, column_name, data_type from information_schema.columns where table_schema='public'",
)).rows;
const hasCol = (t, c) => cols.some((r) => r.table_name === t && r.column_name === c);
for (const [t, c] of [
  ['chapters', 'digest'], ['chapters', 'result'], ['chapters', 'enriched'],
  ['chapters', 'enrichment'], ['chapters', 'source_hash'], ['chapters', 'analysis_revision'],
  ['chapters', 'enrichment_revision'], ['chapters', 'duration_ms'],
  ['projects', 'book_result'], ['projects', 'content_revision'],
  ['projects', 'aggregated_revision'], ['projects', 'aggregate_status'],
  ['projects', 'next_chapter_index'], ['projects', 'create_request_id'],
  ['project_sources', 'raw_text'],
  ['jobs', 'lease_expires_at'], ['jobs', 'run_after'], ['jobs', 'attempts'], ['jobs', 'target_revision'],
  ['speaker_assignments', 'target_role_snapshot'], ['speaker_assignments', 'target_role_key'],
  ['speaker_change_logs', 'old_role_snapshot'], ['speaker_change_logs', 'new_role_snapshot'],
]) (hasCol(t, c) ? ok : bad)(`${t}.${c}`);
(hasCol('feedback', 'rating') ? bad : ok)('feedback.rating 已移除');

// ------------------------------------------------------------------ 3. 索引
console.log('\n[3] 并发防重复索引');
const idx = (await client.query("select indexname from pg_indexes where schemaname='public'")).rows.map((r) => r.indexname);
for (const i of [
  'jobs_claimable_idx', 'jobs_one_active_aggregate_idx',
  'jobs_one_active_chapter_idx', 'jobs_one_active_chapterize_idx',
  'demo_users_email_lower_key', 'chapters_project_source_hash_key',
  'projects_user_create_request_key',
  'speaker_assignments_project_idx', 'speaker_change_logs_project_idx',
]) (idx.includes(i) ? ok : bad)(`索引 ${i}`);

// -------------------------------------------------------------------- 4. RLS
console.log('\n[4] RLS(所有表必须开启且无 policy)');
const rls = (await client.query(
  `select c.relname, c.relrowsecurity, count(p.polname) as policies
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_policy p on p.polrelid = c.oid
    where n.nspname='public' and c.relkind='r' and c.relname = any($1)
    group by 1,2`, [wantTables],
)).rows;
for (const r of rls) {
  if (!r.relrowsecurity) bad(`${r.relname} 未开启 RLS`);
  else if (Number(r.policies) > 0) bad(`${r.relname} 存在 ${r.policies} 条 policy(应为 0)`);
  else ok(`${r.relname} RLS 开启且无 policy`);
}

// ------------------------------------------------------------------ 5. 函数
console.log('\n[5] 队列函数');
const fns = (await client.query(
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'",
)).rows.map((r) => r.proname);
for (const f of [
  'claim_next_job', 'finish_chapter_job', 'fail_job', 'finish_aggregate_job',
  'requeue_failed_chapters', 'append_chapter_batch', 'commit_chapterize_result',
  'create_per_chapter_project',
  'save_chapter_enrichment_batch',
  'set_speaker_assignment',
  'mark_aggregate_running', 'mark_aggregate_failed', 'requeue_aggregate', 'touch_updated_at',
])
  (fns.includes(f) ? ok : bad)(`函数 ${f}`);

// ------------------------------- 6. anon 必须被拒(邮箱凭据不能变成数据库凭据)
console.log('\n[6] anon/publishable key 必须被拒绝');
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});
const anonRead = await anon.from('projects').select('id').limit(1);
if (anonRead.error) ok(`anon 读 projects 被拒: ${anonRead.error.message.slice(0, 60)}`);
else if ((anonRead.data ?? []).length === 0) ok('anon 读 projects 返回空(RLS 生效)');
else bad(`anon 竟然读到了 ${anonRead.data.length} 行`);

const anonWrite = await anon.from('demo_users').insert({ email: 'anon-probe@test.local' });
if (anonWrite.error) ok(`anon 写 demo_users 被拒: ${anonWrite.error.message.slice(0, 60)}`);
else bad('anon 竟然写入成功 —— RLS 失效!');

// secret key 必须能用
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const svcRead = await svc.from('projects').select('id').limit(1);
(svcRead.error ? bad : ok)(svcRead.error ? `secret key 读失败: ${svcRead.error.message}` : 'secret key 可读 projects');

// -------------------- 7. 竞态: 两章同时完成, 必须恰好产生一个 aggregate
console.log('\n[7] 竞态测试: "谁是最后一章"(关键)');
await client.query('begin');
try {
  const u = (await client.query("insert into demo_users (email) values ('race-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id")).rows[0].id;
  const p = (await client.query(
    "insert into projects (user_id, title, source_mode, status, chapters_total, content_revision, aggregate_status) values ($1,'race','whole_book','processing',2,1,'dirty') returning id", [u],
  )).rows[0].id;
  const c1 = (await client.query("insert into chapters (project_id, chapter_index, title, source_text) values ($1,1,'c1','x') returning id", [p])).rows[0].id;
  const c2 = (await client.query("insert into chapters (project_id, chapter_index, title, source_text) values ($1,2,'c2','y') returning id", [p])).rows[0].id;
  const j1 = (await client.query("insert into jobs (project_id, chapter_id, kind, target_revision) values ($1,$2,'chapter',1) returning id", [p, c1])).rows[0].id;
  const j2 = (await client.query("insert into jobs (project_id, chapter_id, kind, target_revision) values ($1,$2,'chapter',1) returning id", [p, c2])).rows[0].id;

  const r1 = (await client.query('select finish_chapter_job($1,$2,true,null) as r', [j1, c1])).rows[0].r;
  const r2 = (await client.query('select finish_chapter_job($1,$2,true,null) as r', [j2, c2])).rows[0].r;
  const aggCount = Number((await client.query("select count(*) from jobs where project_id=$1 and kind='aggregate'", [p])).rows[0].count);

  if (r1.aggregate_created === false && r2.aggregate_created === true) ok('第一章不建 aggregate, 第二章建 —— 计数正确');
  else bad(`aggregate_created 标志异常: r1=${r1.aggregate_created} r2=${r2.aggregate_created}`);
  (aggCount === 1 ? ok : bad)(`aggregate 任务数 = ${aggCount}(必须为 1)`);
  (r2.chapters_done === 2 ? ok : bad)(`chapters_done = ${r2.chapters_done}(应为 2)`);

  // 幂等: 重复完成同一章不应重复计数
  const r3 = (await client.query('select finish_chapter_job($1,$2,true,null) as r', [j1, c1])).rows[0].r;
  (r3.chapters_done === 2 ? ok : bad)(`重复完成后 chapters_done = ${r3.chapters_done}(应仍为 2, 幂等)`);
  const aggCount2 = Number((await client.query("select count(*) from jobs where project_id=$1 and kind='aggregate'", [p])).rows[0].count);
  (aggCount2 === 1 ? ok : bad)(`重复完成后 aggregate 数 = ${aggCount2}(应仍为 1)`);
} finally {
  await client.query('rollback');   // 测试数据不落库
}

// ---------------------------------------- 8. claim_next_job: skip locked 行为
console.log('\n[8] claim_next_job 原子领取');
await client.query('begin');
try {
  const u = (await client.query("insert into demo_users (email) values ('claim-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id")).rows[0].id;
  const p = (await client.query("insert into projects (user_id,title,source_mode) values ($1,'claim','whole_book') returning id", [u])).rows[0].id;
  await client.query("insert into jobs (project_id, kind) values ($1,'chapterize')", [p]);
  const claimed = (await client.query('select * from claim_next_job(300)')).rows[0];
  if (claimed?.id) {
    ok(`领到任务 kind=${claimed.kind} status=${claimed.status} attempts=${claimed.attempts}`);
    (claimed.status === 'running' ? ok : bad)(`领取后 status=${claimed.status}(应为 running)`);
    (claimed.attempts === 1 ? ok : bad)(`领取后 attempts=${claimed.attempts}(应为 1)`);
    (claimed.lease_expires_at ? ok : bad)('lease_expires_at 已设置');
  } else bad('未能领到任务');
} finally {
  await client.query('rollback');
}


// -------------------- 9. 重试路径: 失败章节重试后必须能重新聚合
console.log('\n[9] 重试路径(曾有两个缺陷, 见 0004)');
await client.query('begin');
try {
  const u = (await client.query("insert into demo_users (email) values ('retry-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id")).rows[0].id;
  const p = (await client.query("insert into projects (user_id,title,source_mode,status,chapters_total,content_revision,aggregate_status) values ($1,'retry','whole_book','processing',3,1,'dirty') returning id", [u])).rows[0].id;
  const ch = [];
  for (let i = 1; i <= 3; i += 1) {
    ch.push((await client.query('insert into chapters (project_id,chapter_index,title,source_text) values ($1,$2,$3,$4) returning id', [p, i, `c${i}`, 'x'])).rows[0].id);
  }
  const jobFor = async (cid, revision = 1) => (await client.query(
    "insert into jobs (project_id,chapter_id,kind,target_revision) values ($1,$2,'chapter',$3) returning id",
    [p, cid, revision],
  )).rows[0].id;
  await client.query('select finish_chapter_job($1,$2,true,null)', [await jobFor(ch[0]), ch[0]]);
  await client.query('select finish_chapter_job($1,$2,true,null)', [await jobFor(ch[1]), ch[1]]);
  await client.query("select finish_chapter_job($1,$2,false,'boom')", [await jobFor(ch[2]), ch[2]]);

  // 第一轮聚合跑完
  const aggId = (await client.query("select id from jobs where project_id=$1 and kind='aggregate'", [p])).rows[0].id;
  await client.query("select finish_aggregate_job($1,$2,1,'{}'::jsonb)", [aggId, p]);
  const mid = (await client.query('select status, chapters_failed from projects where id=$1', [p])).rows[0];
  (mid.status === 'partially_failed' ? ok : bad)(`一章失败后 project.status=${mid.status}(应 partially_failed)`);

  // 用户重试
  const rq = (await client.query('select requeue_failed_chapters($1,3) as r', [p])).rows[0].r;
  (rq.requeued === 1 ? ok : bad)(`requeue 了 ${rq.requeued} 章(应为 1)`);
  const afterRq = (await client.query('select chapters_failed from projects where id=$1', [p])).rows[0];
  (Number(afterRq.chapters_failed) === 0 ? ok : bad)(`requeue 后 chapters_failed=${afterRq.chapters_failed}(必须回退为 0)`);

  const retryJob = (await client.query(
    "select id from jobs where project_id=$1 and chapter_id=$2 and status='pending' order by created_at desc limit 1",
    [p, ch[2]],
  )).rows[0].id;
  await client.query('select finish_chapter_job($1,$2,true,null)', [retryJob, ch[2]]);
  const pendingAgg = Number((await client.query("select count(*) from jobs where project_id=$1 and kind='aggregate' and status in ('pending','running')", [p])).rows[0].count);
  (pendingAgg === 1 ? ok : bad)(`重试成功后待跑 aggregate=${pendingAgg}(必须为 1, 否则项目卡死)`);
  const fin = (await client.query('select chapters_done, chapters_failed from projects where id=$1', [p])).rows[0];
  (Number(fin.chapters_done) === 3 && Number(fin.chapters_failed) === 0 ? ok : bad)(`最终计数 done=${fin.chapters_done} failed=${fin.chapters_failed}(应 3/0)`);
} finally {
  await client.query('rollback');
}

// ------------------------ 10. 删除项目必须清理全部项目级内容
console.log('\n[10] 项目级联删除');
await client.query('begin');
try {
  const u = (await client.query(
    "insert into demo_users (email) values ('delete-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id",
  )).rows[0].id;
  const p = (await client.query(
    "insert into projects (user_id,title,source_mode) values ($1,'delete','whole_book') returning id", [u],
  )).rows[0].id;
  await client.query("insert into project_sources (project_id,raw_text,char_count) values ($1,'text',4)", [p]);
  const c = (await client.query(
    "insert into chapters (project_id,chapter_index,title,source_text) values ($1,1,'c1','text') returning id", [p],
  )).rows[0].id;
  const j = (await client.query(
    "insert into jobs (project_id,chapter_id,kind,target_revision) values ($1,$2,'chapter',1) returning id", [p, c],
  )).rows[0].id;
  await client.query(
    "insert into job_events (job_id,project_id,chapter_id,stage,message) values ($1,$2,$3,'probe','delete')",
    [j, p, c],
  );
  await client.query(
    "insert into feedback (user_id,project_id,chapter_id,category,comment) values ($1,$2,$3,'other','delete')",
    [u, p, c],
  );
  await client.query(
    "insert into llm_calls (project_id,chapter_id,job_id,purpose,status,attempt) values ($1,$2,$3,'probe','ok',1)",
    [p, c, j],
  );
  const assignment = (await client.query(
    `insert into speaker_assignments (
       project_id,chapter_id,segment_id,segment_text,original_speaker,target_role_key,
       target_role_snapshot,changed_by
     ) values ($1,$2,'segment-1','hello','unknown_speaker','role-1',$3,$4)
     returning id`,
    [p, c, JSON.stringify({ role_id: 'role-1', canonical_name: '角色一' }), u],
  )).rows[0].id;
  await client.query(
    `insert into speaker_change_logs (
       assignment_id,project_id,chapter_id,segment_id,old_role_snapshot,new_role_snapshot,changed_by
     ) values ($1,$2,$3,'segment-1',$4,$5,$6)`,
    [
      assignment,
      p,
      c,
      JSON.stringify({ canonical_name: 'unknown_speaker' }),
      JSON.stringify({ role_id: 'role-1', canonical_name: '角色一' }),
      u,
    ],
  );

  await client.query('delete from projects where id=$1', [p]);

  for (const [table, column] of [
    ['projects', 'id'],
    ['project_sources', 'project_id'],
    ['chapters', 'project_id'],
    ['chapter_upload_batches', 'project_id'],
    ['jobs', 'project_id'],
    ['job_events', 'project_id'],
    ['feedback', 'project_id'],
    ['llm_calls', 'project_id'],
    ['speaker_assignments', 'project_id'],
    ['speaker_change_logs', 'project_id'],
  ]) {
    const count = Number((await client.query(`select count(*) from ${table} where ${column}=$1`, [p])).rows[0].count);
    (count === 0 ? ok : bad)(`${table} 项目数据删除后剩余 ${count} 行`);
  }
} finally {
  await client.query('rollback');
}

// ---------------- 11. 原子追加: 序号、计数、任务与 request_id 幂等
console.log('\n[11] 原子追加章节批次');
await client.query('begin');
try {
  const u = (await client.query(
    "insert into demo_users (email) values ('append-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id",
  )).rows[0].id;
  const p = (await client.query(
    "insert into projects (user_id,title,source_mode,status) values ($1,'append','per_chapter','processing') returning id",
    [u],
  )).rows[0].id;
  const requestId = randomUUID();
  const payload = [
    { title: '第一章', text: '正文一', source_hash: 'hash-append-1' },
    { title: '第二章', text: '正文二', source_hash: 'hash-append-2' },
  ];
  const first = (await client.query(
    'select append_chapter_batch($1,$2,$3::jsonb,3) as r',
    [p, requestId, JSON.stringify(payload)],
  )).rows[0].r;
  const replay = (await client.query(
    'select append_chapter_batch($1,$2,$3::jsonb,3) as r',
    [p, requestId, JSON.stringify(payload)],
  )).rows[0].r;
  const counts = (await client.query(
    "select p.chapters_total,p.next_chapter_index,p.content_revision,count(j.id) filter (where j.kind='chapter') as jobs from projects p left join jobs j on j.project_id=p.id where p.id=$1 group by p.id",
    [p],
  )).rows[0];
  (first.added === 2 && first.start_index === 1 && first.end_index === 2 ? ok : bad)(
    `首批范围 ${first.start_index}-${first.end_index}, added=${first.added}`,
  );
  (replay.idempotent === true ? ok : bad)('相同 request_id 重放返回 idempotent=true');
  (Number(counts.chapters_total) === 2 && Number(counts.jobs) === 2 ? ok : bad)(
    `重放后 total=${counts.chapters_total}, chapter jobs=${counts.jobs}(均不得翻倍)`,
  );
  (Number(counts.next_chapter_index) === 3 && Number(counts.content_revision) === 1 ? ok : bad)(
    `next_index=${counts.next_chapter_index}, revision=${counts.content_revision}`,
  );
} finally {
  await client.query('rollback');
}

// ---------------- 12. 聚合版本栅栏: 旧任务不能发布，且必须补建最新聚合
console.log('\n[12] 聚合版本栅栏');
await client.query('begin');
try {
  const u = (await client.query(
    "insert into demo_users (email) values ('revision-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id",
  )).rows[0].id;
  const p = (await client.query(
    `insert into projects (
       user_id,title,source_mode,status,chapters_total,chapters_done,next_chapter_index,
       content_revision,aggregated_revision,aggregate_status
     ) values ($1,'revision','per_chapter','processing',1,1,2,1,0,'running') returning id`,
    [u],
  )).rows[0].id;
  await client.query(
    "insert into chapters (project_id,chapter_index,title,source_text,status,created_revision,analysis_revision) values ($1,1,'c1','x','succeeded',1,1)",
    [p],
  );
  const oldAggregate = (await client.query(
    "insert into jobs (project_id,kind,status,target_revision) values ($1,'aggregate','running',1) returning id",
    [p],
  )).rows[0].id;

  const appended = (await client.query(
    'select append_chapter_batch($1,$2,$3::jsonb,3) as r',
    [p, randomUUID(), JSON.stringify([{ title: 'c2', text: 'y', source_hash: 'hash-revision-2' }])],
  )).rows[0].r;
  const c2 = appended.chapters[0].id;
  const c2Job = (await client.query(
    "select id from jobs where chapter_id=$1 and status='pending'",
    [c2],
  )).rows[0].id;
  await client.query('select finish_chapter_job($1,$2,true,null)', [c2Job, c2]);

  const stale = (await client.query(
    "select finish_aggregate_job($1,$2,1,'{\"stale\":true}'::jsonb) as r",
    [oldAggregate, p],
  )).rows[0].r;
  const state = (await client.query(
    'select book_result,content_revision,aggregated_revision,aggregate_status from projects where id=$1',
    [p],
  )).rows[0];
  const nextAggregate = (await client.query(
    "select target_revision from jobs where project_id=$1 and kind='aggregate' and status='pending'",
    [p],
  )).rows[0];

  (stale.published === false ? ok : bad)('旧 revision 聚合 published=false');
  (state.book_result === null && Number(state.aggregated_revision) === 0 ? ok : bad)(
    '旧聚合没有覆盖 book_result / aggregated_revision',
  );
  (Number(state.content_revision) === 2 && state.aggregate_status === 'dirty' ? ok : bad)(
    `当前 revision=${state.content_revision}, aggregate_status=${state.aggregate_status}`,
  );
  (Number(nextAggregate?.target_revision) === 2 ? ok : bad)(
    `补建最新 aggregate target_revision=${nextAggregate?.target_revision}`,
  );
} finally {
  await client.query('rollback');
}

// ---------------- 13. 首批建项也必须按 request_id 幂等
console.log('\n[13] 逐章项目原子创建');
await client.query('begin');
try {
  const u = (await client.query(
    "insert into demo_users (email) values ('create-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id",
  )).rows[0].id;
  const requestId = randomUUID();
  const payload = [{ title: '第一章', text: '正文', source_hash: 'hash-create-1' }];
  const first = (await client.query(
    'select create_per_chapter_project($1,$2,$3,$4::jsonb,3) as r',
    [u, '原子创建', requestId, JSON.stringify(payload)],
  )).rows[0].r;
  const replay = (await client.query(
    'select create_per_chapter_project($1,$2,$3,$4::jsonb,3) as r',
    [u, '原子创建', requestId, JSON.stringify(payload)],
  )).rows[0].r;
  const projectCount = Number((await client.query(
    'select count(*) from projects where user_id=$1 and create_request_id=$2',
    [u, requestId],
  )).rows[0].count);
  const chapterCount = Number((await client.query(
    'select count(*) from chapters where project_id=$1',
    [first.project_id],
  )).rows[0].count);
  (first.project_id === replay.project_id && replay.idempotent === true ? ok : bad)(
    '相同创建 request_id 返回同一 project_id',
  );
  (projectCount === 1 && chapterCount === 1 ? ok : bad)(
    `项目数=${projectCount}, 章节数=${chapterCount}(均应为 1)`,
  );
} finally {
  await client.query('rollback');
}

// ---------------- 14. 说话人修正：人物范围限制、当前指派与日志
console.log('\n[14] 说话人修改日志');
await client.query('begin');
try {
  const u = (await client.query(
    "insert into demo_users (email) values ('speaker-probe@test.local') on conflict (lower(email)) do update set last_seen_at=now() returning id",
  )).rows[0].id;
  const roleOne = { role_id: 'role-1', canonical_name: '角色一', gender: 'female', voice_profile: { description: '女声' } };
  const roleTwo = { role_id: 'role-2', canonical_name: '角色二', gender: 'male', voice_profile: { description: '男声' } };
  const p = (await client.query(
    `insert into projects (user_id,title,source_mode,book_result)
     values ($1,'speaker','whole_book',$2::jsonb) returning id`,
    [u, JSON.stringify({ role_registry: [roleOne, roleTwo] })],
  )).rows[0].id;
  const c = (await client.query(
    "insert into chapters (project_id,chapter_index,title,source_text) values ($1,1,'c1','“你好。”') returning id",
    [p],
  )).rows[0].id;

  const first = (await client.query(
    `select set_speaker_assignment(
       $1,$2,'segment-1',1,4,'你好。','unknown_speaker','','role-1',$3
     ) as r`,
    [p, c, u],
  )).rows[0].r;
  const replay = (await client.query(
    `select set_speaker_assignment(
       $1,$2,'segment-1',1,4,'你好。','unknown_speaker','','role-1',$3
     ) as r`,
    [p, c, u],
  )).rows[0].r;
  const second = (await client.query(
    `select set_speaker_assignment(
       $1,$2,'segment-1',1,4,'你好。','unknown_speaker','','role-2',$3
     ) as r`,
    [p, c, u],
  )).rows[0].r;
  const counts = (await client.query(
    `select
       (select count(*) from speaker_assignments where chapter_id=$1) as assignments,
       (select count(*) from speaker_change_logs where chapter_id=$1) as logs`,
    [c],
  )).rows[0];

  (first.changed === true && first.assignment.target_role_key === 'role-1' ? ok : bad)(
    '首次修改创建当前指派并写入角色一',
  );
  (replay.changed === false && replay.log_id === null ? ok : bad)(
    '重复选择同一人物不重复写日志',
  );
  (second.changed === true && second.assignment.target_role_key === 'role-2' ? ok : bad)(
    '再次修改更新当前指派为角色二',
  );
  (Number(counts.assignments) === 1 && Number(counts.logs) === 2 ? ok : bad)(
    `当前指派=${counts.assignments} 条，修改日志=${counts.logs} 条(应为 1/2)`,
  );

  let rejected = false;
  try {
    await client.query(
      `select set_speaker_assignment(
         $1,$2,'segment-2',5,8,'再见。','unknown_speaker','','not-in-novel',$3
       )`,
      [p, c, u],
    );
  } catch (error) {
    rejected = /not in current project role registry/i.test(error.message);
  }
  (rejected ? ok : bad)('小说人物列表之外的目标说话人被拒绝');
} finally {
  await client.query('rollback');
}

await client.end();
console.log(fail === 0 ? '\n✅ Phase 1 schema 全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
