import { database } from './supabase.mjs';
import { hashPassword } from './password.mjs';
const e = process.env;
const role = e.ACCOUNT_ROLE || 'admin';
if (!['superAdmin','admin','employee'].includes(role) || !e.ACCOUNT_USERNAME?.trim() || (e.ACCOUNT_PASSWORD?.length ?? 0) < 12) throw new Error('Supply a username, password of at least 12 characters, and valid role');
const shopId = role === 'superAdmin' ? '' : e.SHOP_ID?.trim();
if (role !== 'superAdmin' && !shopId) throw new Error('SHOP_ID is required');
const headers = { Prefer: 'resolution=merge-duplicates,return=representation' };
if (role !== 'superAdmin') {
  const existing = await database('cloud_pharmacies', new URLSearchParams({ shop_id: `eq.${shopId}`, select: 'shop_id' }));
  if (e.PHARMACY_NAME && e.PHARMACY_ADDRESS) {
    await database('cloud_pharmacies', 'on_conflict=shop_id', { method: 'POST', headers, body: JSON.stringify({ shop_id: shopId, name: e.PHARMACY_NAME, address: e.PHARMACY_ADDRESS, phone: e.PHARMACY_PHONE || '', updated_at: new Date().toISOString() }) });
  } else if (!existing.length) throw new Error('Supply PHARMACY_NAME and PHARMACY_ADDRESS for a new pharmacy');
}
await database('cloud_accounts', 'on_conflict=shop_id,username', { method: 'POST', headers, body: JSON.stringify({ shop_id: shopId, username: e.ACCOUNT_USERNAME.trim(), password_hash: await hashPassword(e.ACCOUNT_PASSWORD), role, active: true }) });
console.log('Cloud account saved.');
