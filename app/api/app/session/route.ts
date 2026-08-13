import { handleRoute, requireEmail } from '@/src/server/api/helpers';
import { sessionSchema } from '@/src/server/api/schemas';
import { upsertUserByEmail } from '@/src/server/db/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 登记/识别用户。不使用 Supabase Auth —— 邮箱直接 upsert 进自建 demo_users。
 * 邮箱未经验证, 所以它既是标识也是凭据; 前端需明示 demo 项目非私密。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = sessionSchema.parse(await request.json());
    const email = requireEmail(body.email);
    const user = await upsertUserByEmail(email);
    return { user_id: user.id, email: user.email, created_at: user.created_at };
  });
}
