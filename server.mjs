import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { database } from './supabase.mjs';
import { hashPassword, verifyPassword } from './password.mjs';
import { bootstrapSuperAdmin } from './bootstrap.mjs';

export function createApp({ db = database } = {}) {
  // Bound per-instance throttling. Never trust a client-supplied forwarded IP.
  let attempts = 0;
  let windowStart = Date.now();
  const dummy = hashPassword('invalid-account-placeholder');
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') {
        await db('cloud_pharmacies', 'select=shop_id&limit=1');
        return send(200, { status: 'ok' });
      }
      if (req.method !== 'POST' || req.url !== '/api/login') return send(404, { message: 'Not found' });
      if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
      if (++attempts > 60) return send(429, { message: 'Too many login attempts. Try again in a minute.' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) return send(413, { message: 'Request too large' });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return send(400, { message: 'Invalid JSON' }); }
      const { username, password, shopId = '' } = body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string' || typeof shopId !== 'string' || !username.trim() || !password || password.length > 1024) return send(400, { message: 'Username and password are required' });
      const query = new URLSearchParams({ username: `eq.${username.trim()}`, shop_id: `eq.${shopId.trim()}`, select: '*' });
      const accounts = await db('cloud_accounts', query);
      const account = accounts[0];
      const valid = await verifyPassword(password, account?.password_hash ?? await dummy);
      if (!valid || !account?.active) return send(401, { message: 'Invalid username, password, or Shop ID.' });
      let pharmacy = null;
      if (account.role !== 'superAdmin') {
        const shops = await db('cloud_pharmacies', new URLSearchParams({ shop_id: `eq.${account.shop_id}`, select: '*' }));
        pharmacy = shops[0];
        if (!pharmacy || pharmacy.status !== 'active' || (!pharmacy.is_lifetime && pharmacy.license_expiry_date && Date.parse(pharmacy.license_expiry_date) <= Date.now())) return send(403, { message: 'Pharmacy access suspended or license expired.' });
      }
      return send(200, { role: account.role, username: account.username, shopId: account.shop_id, pharmacy });
    } catch {
      return send(503, { message: 'Cloud service unavailable. Please try again.' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
  await bootstrapSuperAdmin();
  createApp().listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
