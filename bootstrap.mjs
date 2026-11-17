import { database } from './supabase.mjs';
import { hashPassword, verifyPassword } from './password.mjs';

export async function bootstrapSuperAdmin({ env = process.env, db = database } = {}) {
  const username = env.SUPER_ADMIN_USERNAME?.trim();
  const password = env.SUPER_ADMIN_PASSWORD;
  if (!username || !password || password.length < 1 || password.length > 1024 || password !== password.trim()) {
    throw new Error('Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD (1–1024 characters, no surrounding whitespace)');
  }

  const query = new URLSearchParams({
    shop_id: 'eq.',
    username: `eq.${username}`,
    select: 'id,role,active,password_hash',
  });
  const existing = await db('cloud_accounts', query);
  const account = existing[0];
  if (account) {
    if (account.role !== 'superAdmin' || account.active !== true) {
      throw new Error('The configured Super Admin account exists but is disabled or has a conflicting role; refusing to overwrite it');
    }
    if (!await verifyPassword(password, account.password_hash)) {
      throw new Error('The configured Super Admin account exists but its password does not match; refusing to overwrite existing credentials');
    }
    return { created: false };
  }

  await db('cloud_accounts', 'on_conflict=shop_id,username', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      shop_id: '',
      username,
      password_hash: await hashPassword(password),
      role: 'superAdmin',
      active: true,
    }),
  });
  return { created: true };
}
