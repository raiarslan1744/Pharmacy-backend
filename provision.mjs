import { pathToFileURL } from 'node:url';
import { database } from './supabase.mjs';
import { hashPassword } from './password.mjs';

export async function provisionCloudAccount({ env = process.env, db = database } = {}) {
  const role = env.ACCOUNT_ROLE || 'admin';
  const username = env.ACCOUNT_USERNAME?.trim();
  const password = env.ACCOUNT_PASSWORD;
  if (!['superAdmin', 'admin', 'employee'].includes(role) || !username || !password || password.length < 1 || password.length > 1024 || password !== password.trim()) {
    throw new Error('Supply a username, password of 1–1024 characters with no surrounding whitespace, and a valid role');
  }
  const shopId = role === 'superAdmin' ? '' : env.SHOP_ID?.trim();
  if (role !== 'superAdmin' && !shopId) throw new Error('SHOP_ID is required');

  const headers = { Prefer: 'resolution=merge-duplicates,return=representation' };
  if (role !== 'superAdmin') {
    const existing = await db('cloud_pharmacies', new URLSearchParams({ shop_id: `eq.${shopId}`, select: 'shop_id' }));
    if (env.PHARMACY_NAME && env.PHARMACY_ADDRESS) {
      await db('cloud_pharmacies', 'on_conflict=shop_id', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          shop_id: shopId,
          name: env.PHARMACY_NAME,
          address: env.PHARMACY_ADDRESS,
          phone: env.PHARMACY_PHONE || '',
          updated_at: new Date().toISOString(),
        }),
      });
    } else if (!existing.length) {
      throw new Error('Supply PHARMACY_NAME and PHARMACY_ADDRESS for a new pharmacy');
    }
  }

  await db('cloud_accounts', 'on_conflict=shop_id,username', {
    method: 'POST',
    headers,
    body: JSON.stringify({ shop_id: shopId, username, password_hash: await hashPassword(password), role, active: true }),
  });
  return { shopId, username, role };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await provisionCloudAccount();
  console.log('Cloud account saved.');
}
