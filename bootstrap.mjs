import { database } from './supabase.mjs';
import { hashPassword, verifyPassword } from './password.mjs';

export async function bootstrapSuperAdmin({ env = process.env, db = database } = {}) {
  const username = env.SUPER_ADMIN_USERNAME?.trim();
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!username || !password || password.length < 12 || password.length > 1024 || password !== password.trim()) {
    throw new Error('Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD (12–1024 characters, no surrounding whitespace)');
  }
  const existing = await db('cloud_accounts', new URLSearchParams({ shop_id: 'eq.', username: `eq.${username}`, select: '*' }));
  const account = existing[0];
  if (account?.role === 'superAdmin' && account.active && await verifyPassword(password, account.password_hash)) return;
  await db('cloud_accounts', 'on_conflict=shop_id,username', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ shop_id: '', username, password_hash: await hashPassword(password), role: 'superAdmin', active: true }),
  });
}
