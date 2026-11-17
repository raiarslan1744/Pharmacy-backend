import { createHmac, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { database, DatabaseRequestError, databaseErrorSummary } from './supabase.mjs';
import { hashPassword, verifyPassword } from './password.mjs';
import { bootstrapSuperAdmin } from './bootstrap.mjs';
import { SessionTokenManager } from './session.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class RequestBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new RequestBodyError(413, 'Request too large');
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw new RequestBodyError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestBodyError(400, 'Invalid request body');
  return body;
}

function startupErrorSummary(error) {
  if (error instanceof DatabaseRequestError) return databaseErrorSummary(error);
  if (error?.message === 'Missing Supabase configuration') return 'Missing required Supabase configuration.';
  if (error?.message === 'Invalid Supabase project URL') return 'Invalid Supabase project URL; expected the project API origin.';
  if (error?.message?.startsWith('Set SUPER_ADMIN_USERNAME')) return error.message;
  if (error?.message?.startsWith('The configured Super Admin account')) return error.message;
  return 'Unexpected startup error; sensitive details were suppressed.';
}

export async function bootstrapWithRetry({
  bootstrap = bootstrapSuperAdmin,
  sleepImpl = sleep,
  logger = console,
  shouldStop = () => false,
} = {}) {
  let attempt = 0;
  while (!shouldStop()) {
    try {
      await bootstrap();
      return true;
    } catch (error) {
      logger.error(`[startup] Super Admin bootstrap failed: ${startupErrorSummary(error)}`);
      if (!(error instanceof DatabaseRequestError) || !error.retryable) return false;
      const delay = Math.min(1000 * (2 ** Math.min(attempt, 5)), 30_000);
      attempt++;
      await sleepImpl(delay);
    }
  }
  return false;
}

function makeSessionTokenManager(secretKey = process.env.SESSION_SECRET) {
  const secret = secretKey
    ? createHmac('sha256', secretKey).update('qodra-pharmacy:super-admin-session:v1').digest()
    : randomBytes(32);
  return new SessionTokenManager({ secret });
}

function isExpired(pharmacy) {
  return !pharmacy.is_lifetime && (!pharmacy.license_expiry_date || !Number.isFinite(Date.parse(pharmacy.license_expiry_date)) || Date.parse(pharmacy.license_expiry_date) <= Date.now());
}

export function createApp({
  db = database,
  getBootstrapped = () => true,
  logger = console,
  tokenManager = makeSessionTokenManager(),
} = {}) {
  // Bound per-instance throttling. Never trust a client-supplied forwarded IP.
  let loginAttempts = 0;
  let loginWindowStart = Date.now();
  let createAttempts = 0;
  let createWindowStart = Date.now();
  const dummy = hashPassword('invalid-account-placeholder');

  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/version') return send(200, { version: '4', build: process.env.RENDER_GIT_COMMIT || 'local' });
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok' });
      if (req.method === 'GET' && req.url === '/ready') {
        if (!getBootstrapped()) return send(503, { status: 'not_ready' });
        const versions = await db('cloud_schema_versions', 'version=eq.4&select=version');
        if (!versions.length) return send(503, { status: 'migration_required' });
        return send(200, { status: 'ready' });
      }

      if (req.method === 'POST' && req.url === '/api/login') {
        if (!getBootstrapped()) return send(503, { message: 'Cloud service unavailable. Please try again.' });
        if (Date.now() - loginWindowStart > 60_000) { loginAttempts = 0; loginWindowStart = Date.now(); }
        if (++loginAttempts > 60) return send(429, { message: 'Too many login attempts. Try again in a minute.' });
        let body;
        try { body = await readJsonBody(req, 8192); } catch (error) {
          if (error instanceof RequestBodyError) return send(error.status, { message: error.message });
          throw error;
        }
        const { username, password, shopId = '' } = body;
        if (typeof username !== 'string' || typeof password !== 'string' || typeof shopId !== 'string' || !username.trim() || !password || password.length > 1024) {
          return send(400, { message: 'Username and password are required' });
        }
        const query = new URLSearchParams({ username: `eq.${username.trim()}`, shop_id: `eq.${shopId.trim()}`, select: '*' });
        const accounts = await db('cloud_accounts', query);
        const account = accounts[0];
        const valid = await verifyPassword(password, account?.password_hash ?? await dummy);
        if (!valid || !account?.active) return send(401, { message: 'Invalid username, password, or Shop ID.' });

        let pharmacy = null;
        if (account.role !== 'superAdmin') {
          const shops = await db('cloud_pharmacies', new URLSearchParams({ shop_id: `eq.${account.shop_id}`, select: '*' }));
          pharmacy = shops[0];
          if (!pharmacy || pharmacy.status !== 'active' || isExpired(pharmacy)) {
            return send(403, { message: 'Pharmacy access suspended or license expired.' });
          }
        }
        const session = account.role === 'superAdmin' ? tokenManager.issueSuperAdmin(account.id, account.session_version ?? 1) : null;
        if (session) {
          const claims = tokenManager.verify(session.token);
          await db('cloud_admin_sessions', '', { method: 'POST', body: JSON.stringify({ session_id: claims.jti, account_id: account.id, credential_version: claims.ver, expires_at: new Date(session.expiresAt).toISOString() }) });
        }
        return send(200, {
          role: account.role,
          username: account.username,
          shopId: account.shop_id,
          pharmacy,
          ...(session ? { accessToken: session.token, tokenExpiresAt: new Date(session.expiresAt).toISOString() } : {}),
        });
      }

      if ((req.url === '/api/admin/shops' && ['POST', 'GET'].includes(req.method)) || (req.method === 'POST' && ['/api/logout', '/api/admin/shops/manage'].includes(req.url))) {
        const authorization = req.headers.authorization ?? '';
        const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization);
        const claims = match ? tokenManager.verify(match[1]) : null;
        if (!claims) return send(401, { message: 'Super Admin session is invalid or expired. Sign in again.' });
        const authorized = await db('cloud_accounts', new URLSearchParams({
          id: `eq.${claims.sub}`,
          role: 'eq.superAdmin',
          active: 'eq.true',
          shop_id: 'eq.',
          select: 'id,username,session_version',
        }));
        const superAdmin = authorized[0];
        if (!superAdmin) return send(403, { message: 'Super Admin authorization is required.' });

        const sessions = await db('cloud_admin_sessions', new URLSearchParams({ session_id: `eq.${claims.jti}`, account_id: `eq.${claims.sub}`, revoked_at: 'is.null', select: '*' }));
        const stored = sessions[0];
        if (!stored || stored.credential_version !== claims.ver || (superAdmin.session_version ?? 1) !== claims.ver || Date.parse(stored.expires_at) <= Date.now()) return send(401, { message: 'Session revoked or expired.' });
        if (req.url === '/api/logout') {
          await db('cloud_admin_sessions', new URLSearchParams({ session_id: `eq.${claims.jti}` }), { method: 'PATCH', body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
          return send(200, { success: true });
        }
        if (req.method === 'GET') {
          const rows = [];
          for (let offset = 0; ; offset += 100) {
            const page = await db('cloud_pharmacies', `select=shop_id,name,address,phone,status,is_lifetime,license_expiry_date,archived_at,updated_at,cloud_accounts!cloud_accounts_pharmacy_shop_fk(username,active,role)&order=shop_id&limit=100&offset=${offset}`);
            rows.push(...page);
            if (page.length < 100) break;
          }
          return send(200, { shops: rows.map(row => {
            const admins = (row.cloud_accounts ?? []).filter(account => account.role === 'admin');
            return { shopId: row.shop_id, name: row.name, address: row.address, phone: row.phone,
              status: row.status, isLifetime: row.is_lifetime, licenseExpiryDate: row.license_expiry_date,
              archived: row.archived_at != null, updatedAt: row.updated_at,
              username: admins.length === 1 ? admins[0].username : '',
              adminActive: admins.length === 1 ? admins[0].active : null, adminCount: admins.length };
          }) });
        }
        if (!getBootstrapped()) return send(503, { message: 'Cloud service unavailable.' });
        if (req.url === '/api/admin/shops/manage') {
          const body = await readJsonBody(req);
          if (typeof body.shopId !== 'string' || !body.shopId.trim() || !['update', 'status', 'license', 'archive', 'restore', 'account'].includes(body.action) || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return send(400, { message: 'Invalid shop operation.' });
          const payload = { ...body.payload };
          if (body.action === 'status' && !['active', 'suspended'].includes(payload.status)) return send(400, { message: 'Choose active or suspended.' });
          if (body.action === 'account' && typeof payload.active !== 'boolean') return send(400, { message: 'Choose whether the Shop Admin account is active.' });
          if (body.action === 'license' && (typeof payload.isLifetime !== 'boolean' || (!payload.isLifetime && (typeof payload.licenseExpiryDate !== 'string' || !Number.isFinite(Date.parse(payload.licenseExpiryDate)))))) return send(400, { message: 'A valid license expiry or lifetime license is required.' });
          delete payload.passwordHash;
          if (payload.password !== undefined) {
            if (typeof payload.password !== 'string' || payload.password.length < 12 || payload.password.length > 1024 || payload.password !== payload.password.trim()) return send(400, { message: 'Invalid password.' });
            payload.passwordHash = await hashPassword(payload.password);
            delete payload.password;
          }
          const shop = await db('rpc/manage_cloud_shop', '', { method: 'POST', body: JSON.stringify({ p_actor_id: Number(claims.sub), p_shop_id: body.shopId.trim(), p_action: body.action, p_payload: payload }) });
          return send(200, { success: true, shop });
        }
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return send(400, { message: 'Idempotency-Key of 16–128 characters is required.' });
        if (Date.now() - createWindowStart > 60_000) { createAttempts = 0; createWindowStart = Date.now(); }
        if (++createAttempts > 10) return send(429, { message: 'Too many shop creation attempts. Try again in a minute.' });

        let body;
        try { body = await readJsonBody(req); } catch (error) {
          if (error instanceof RequestBodyError) return send(error.status, { message: error.message });
          throw error;
        }
        const shopId = typeof body.shopId === 'string' ? body.shopId.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const address = typeof body.address === 'string' ? body.address.trim() : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = body.password;
        const isLifetime = body.isLifetime;
        let licenseExpiryDate = null;
        if (typeof body.licenseExpiryDate === 'string' && body.licenseExpiryDate.trim()) {
          const expiry = Date.parse(body.licenseExpiryDate);
          if (!Number.isFinite(expiry)) return send(400, { message: 'License expiry date is invalid.' });
          licenseExpiryDate = new Date(expiry).toISOString();
        }
        if (!shopId || shopId.length > 128 || !name || name.length > 255 || !address || address.length > 1024 || phone.length > 64 || !username || username.length > 128) {
          return send(400, { message: 'Shop ID, shop name, address, and username are required and must be within the allowed lengths.' });
        }
        if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || password !== password.trim()) {
          return send(400, { message: 'Shop Admin password must be 12–1024 characters with no surrounding whitespace.' });
        }
        if (typeof isLifetime !== 'boolean' || (!isLifetime && !licenseExpiryDate)) {
          return send(400, { message: 'A valid expiry date is required for a non-lifetime license.' });
        }
        // The RPC validates expiry for new requests, after checking for a replay.

        const passwordHash = await hashPassword(password);
        let result;
        try {
          result = await db('rpc/create_cloud_shop_idempotent', '', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              p_actor_id: Number(claims.sub),
              p_idempotency_key_hash: createHash('sha256').update(key).digest('hex'),
              p_request_hash: createHmac('sha256', tokenManager.secret).update(JSON.stringify([shopId, name, address, phone, username, password, isLifetime, licenseExpiryDate])).digest('hex'),
              p_shop_id: shopId,
              p_name: name,
              p_address: address,
              p_phone: phone,
              p_license_expiry_date: isLifetime ? null : licenseExpiryDate,
              p_is_lifetime: isLifetime,
              p_username: username,
              p_password_hash: passwordHash,
            }),
          });
        } catch (error) {
          if (error instanceof DatabaseRequestError && error.code === '22023') return send(400, { message: 'Invalid input or idempotency key reused with different details.' });
          if (error instanceof DatabaseRequestError && error.status === 409) {
            return send(409, { message: 'Shop ID or username already exists for this shop.' });
          }
          throw error;
        }
        return send(201, {
          success: true,
          message: 'Shop and Shop Admin account created successfully.',
          shop: result,
        });
      }

      return send(404, { message: 'Not found' });
    } catch (error) {
      if (error instanceof DatabaseRequestError && error.status === 409) return send(409, { message: 'A cloud identity already exists.' });
      if (error instanceof DatabaseRequestError && error.code === '42501') return send(403, { message: 'Super Admin authorization is required.' });
      if (error instanceof RequestBodyError) return send(error.status, { message: error.message });
      if (error instanceof DatabaseRequestError && ['22023', '23514', 'PZ002', 'PZ003', 'PZ005'].includes(error.code)) return send(400, { message: 'Shop operation rejected. Verify the details and current shop state.' });
      if (error instanceof DatabaseRequestError && error.code === 'P0002') return send(404, { message: 'Shop not found.' });
      logger.error(`[request] ${databaseErrorSummary(error)}`);
      return send(503, { message: 'Cloud service unavailable. Please try again.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SESSION_SECRET || Buffer.byteLength(process.env.SESSION_SECRET) < 32) throw new Error('SESSION_SECRET must contain at least 32 random bytes of secret material');
  let bootstrapped = false;
  const app = createApp({ getBootstrapped: () => bootstrapped });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.info('[startup] HTTP server listening'));
  void bootstrapWithRetry({
    bootstrap: async () => {
      await bootstrapSuperAdmin();
      bootstrapped = true;
      console.info('[startup] Super Admin bootstrap completed');
    },
  });
}
