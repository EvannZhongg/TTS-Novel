// 按顺序执行 supabase/migrations/*.sql，并用 schema_migrations 表记录已执行的文件，
// 重复运行只跑新增的迁移。
//
// 用法:
//   node scripts/migrate.mjs          执行未应用的迁移
//   node scripts/migrate.mjs --status  只看状态
//
// 连接信息取自 .env 的 SUPABASE_DB_*。Supabase 直连主机只有 IPv6 记录，
// 所以强制 ipv6first；若本地网络无 IPv6，改用 pooler 主机(见 --help 提示)。
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { Client } from 'pg';
import nextEnv from '@next/env';

dns.setDefaultResultOrder('ipv6first');
nextEnv.loadEnvConfig(process.cwd());

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const statusOnly = process.argv.includes('--status');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少环境变量 ${name}(应在 .env 中配置)`);
    process.exit(1);
  }
  return value;
}

const client = new Client({
  host: requireEnv('SUPABASE_DB_HOST'),
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  user: process.env.SUPABASE_DB_USER || 'postgres',
  password: requireEnv('SUPABASE_DB_PASSWORD'),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  // DDL 建索引/加约束可能偏慢
  statement_timeout: 120000,
});

try {
  await client.connect();
} catch (error) {
  console.error(`连接失败: ${error.message}`);
  console.error('\n如果是 ENOTFOUND/ETIMEDOUT，通常是本地无 IPv6 出口。');
  console.error('可改用 pooler(在 .env 里覆盖):');
  console.error('  SUPABASE_DB_HOST=aws-0-<region>.pooler.supabase.com');
  console.error('  SUPABASE_DB_USER=postgres.jdoplgnnrvejkvfbqoon');
  console.error('region 见 Supabase Dashboard → Project Settings → Database。');
  process.exit(1);
}

await client.query(`
  create table if not exists public.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query('select filename from public.schema_migrations')).rows.map((r) => r.filename),
);
const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

if (statusOnly) {
  for (const file of files) console.log(`${applied.has(file) ? '[applied]' : '[pending]'} ${file}`);
  await client.end();
  process.exit(0);
}

let ran = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip    ${file}`);
    continue;
  }
  const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  process.stdout.write(`apply   ${file} ... `);
  // 每个迁移文件在单个事务里执行，失败则整体回滚
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into public.schema_migrations (filename) values ($1)', [file]);
    await client.query('commit');
    console.log('ok');
    ran += 1;
  } catch (error) {
    await client.query('rollback');
    console.log('FAILED');
    console.error(`\n${file} 执行失败，已回滚:\n  ${error.message}`);
    if (error.position) console.error(`  position: ${error.position}`);
    await client.end();
    process.exit(1);
  }
}

console.log(ran ? `\n完成，应用了 ${ran} 个迁移。` : '\n无需变更，所有迁移都已应用。');
await client.end();
