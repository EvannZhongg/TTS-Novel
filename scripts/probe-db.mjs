// 探测哪个 Supabase Postgres 连接端点可用(直连 IPv6 / 各区域 pooler)。
// 用法: node scripts/probe-db.mjs
import dns from 'node:dns';
import { Client } from 'pg';
import nextEnv from '@next/env';

dns.setDefaultResultOrder('ipv6first');
nextEnv.loadEnvConfig(process.cwd());

const ref = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) {
  console.error('无法从 SUPABASE_URL 解析 project ref');
  process.exit(1);
}
const password = process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('缺少 SUPABASE_DB_PASSWORD');
  process.exit(1);
}

const regions = [
  'ap-southeast-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'ap-southeast-2',
  'us-east-1', 'us-west-1', 'us-east-2', 'eu-central-1', 'eu-west-1', 'eu-west-2',
  'ca-central-1', 'sa-east-1',
];

const targets = [
  { label: 'direct(IPv6)', host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres' },
  // Session mode(5432) 支持事务与 DDL；Transaction mode(6543) 不适合跑迁移
  ...regions.map((r) => ({ label: `pooler-${r}:5432`, host: `aws-0-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${ref}` })),
  ...regions.map((r) => ({ label: `pooler-${r}:6543`, host: `aws-0-${r}.pooler.supabase.com`, port: 6543, user: `postgres.${ref}` })),
];

for (const t of targets) {
  const client = new Client({
    host: t.host, port: t.port, database: 'postgres', user: t.user, password,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 6000,
  });
  try {
    await client.connect();
    const who = await client.query('select current_user');
    console.log(`\n✅ OK  ${t.label}`);
    console.log(`   host=${t.host} port=${t.port} user=${t.user}`);
    console.log(`   current_user=${who.rows[0].current_user}`);
    console.log('\n把下面几行写进 .env:');
    console.log(`   SUPABASE_DB_HOST=${t.host}`);
    console.log(`   SUPABASE_DB_PORT=${t.port}`);
    console.log(`   SUPABASE_DB_USER=${t.user}`);
    await client.end();
    process.exit(0);
  } catch (error) {
    const msg = error.message.replace(/\s+/g, ' ').slice(0, 70);
    // 密码错误说明主机是对的但凭据不符，值得单独提示
    if (/password|authentication|Tenant or user not found/i.test(msg)) {
      console.log(`🔑 ${t.label}: 主机可达但认证失败 -> ${msg}`);
    } else {
      console.log(`   ${t.label}: ${msg}`);
    }
    try { await client.end(); } catch {}
  }
}
console.log('\n没有可用端点。请在 Supabase Dashboard → Project Settings → Database 查看 Connection string。');
process.exit(1);
