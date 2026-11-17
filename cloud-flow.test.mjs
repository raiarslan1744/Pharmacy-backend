import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';
import { bootstrapSuperAdmin } from './bootstrap.mjs';
import { verifyPassword } from './password.mjs';
import { DatabaseRequestError } from './supabase.mjs';
import { SessionTokenManager } from './session.mjs';

function createMemoryDatabase() {
  const tables = { cloud_accounts: [], cloud_pharmacies: [], cloud_admin_sessions: [] };
  let nextAccountId = 1;
  let failNextCreate = false;
  const requests = new Map();
  const db = async (table, query = '', options = null) => {
    if (table === 'rpc/create_cloud_shop_idempotent') {
      if (failNextCreate) {
        failNextCreate = false;
        throw new DatabaseRequestError({ status: 503, code: 'PGRST000', retryable: true });
      }
      const args = JSON.parse(options.body);
      const key = `${args.p_actor_id}:${args.p_idempotency_key_hash}`;
      if (requests.has(key)) {
        const old = requests.get(key);
        if (old.hash !== args.p_request_hash) throw new DatabaseRequestError({status: 400, code: '22023'});
        return old.result;
      }
      if (tables.cloud_pharmacies.some(row => row.shop_id === args.p_shop_id) ||
          tables.cloud_accounts.some(row => row.shop_id === args.p_shop_id && row.username === args.p_username)) {
        throw new DatabaseRequestError({ status: 409, code: '23505', retryable: false });
      }
      const pharmacy = {
        shop_id: args.p_shop_id,
        name: args.p_name,
        address: args.p_address,
        phone: args.p_phone,
        status: 'active',
        is_lifetime: args.p_is_lifetime,
        license_expiry_date: args.p_license_expiry_date,
      };
      const account = {
        id: nextAccountId++,
        shop_id: args.p_shop_id,
        username: args.p_username,
        password_hash: args.p_password_hash,
        role: 'admin',
        active: true,
      };
      tables.cloud_pharmacies.push(pharmacy);
      tables.cloud_accounts.push(account);
      const result = {
        shopId: pharmacy.shop_id,
        name: pharmacy.name,
        address: pharmacy.address,
        phone: pharmacy.phone,
        username: account.username,
        role: account.role,
      };
      requests.set(key, { hash: args.p_request_hash, result });
      return result;
    }

    const rows = tables[table];
    if (!rows) throw new Error('Unknown test table');
    if (options?.method === 'PATCH') {
      const params = new URLSearchParams(query);
      for (const row of rows) if (row.session_id === params.get('session_id')?.slice(3)) Object.assign(row, JSON.parse(options.body));
      return [];
    }
    if (options) {
      const record = JSON.parse(options.body);
      const conflictKeys = String(query).match(/on_conflict=([^&]+)/)?.[1]?.split(',') ?? [];
      const existing = conflictKeys.length
        ? rows.find(row => conflictKeys.every(key => row[key] === record[key]))
        : null;
      if (existing) Object.assign(existing, record);
      else {
        if (table === 'cloud_accounts') record.id = nextAccountId++;
        if (table === 'cloud_pharmacies') Object.assign(record, { status: 'active', is_lifetime: false, license_expiry_date: null }, record);
        rows.push(record);
      }
      return [existing ?? record];
    }
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(String(query));
    return rows.filter(row => [...params.entries()].every(([key, filter]) => {
      if (['select', 'limit', 'order'].includes(key)) return true;
      if (filter === 'is.null') return row[key] == null;
      if (filter.startsWith('eq.')) return String(row[key] ?? '') === filter.slice(3);
      return true;
    }));
  };
  return { db, tables, failCreate: () => { failNextCreate = true; } };
}

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const shopPayload = (overrides = {}) => ({
  shopId: 'SHOP-TEST-01',
  name: 'Isolated Test Pharmacy',
  address: 'Test Address',
  phone: '000-0000',
  username: 'shop-owner',
  password: 'shop-owner-test-password-123',
  licenseExpiryDate: '2099-01-01T00:00:00.000Z',
  isLifetime: false,
  ...overrides,
});

test('authenticated Super Admin creates a cloud shop and a second client can log into it', async t => {
  const { db, tables, failCreate } = createMemoryDatabase();
  const superEnv = { SUPER_ADMIN_USERNAME: 'root', SUPER_ADMIN_PASSWORD: 'root-test-password-123' };
  await bootstrapSuperAdmin({ env: superEnv, db });
  await bootstrapSuperAdmin({ env: superEnv, db });
  assert.equal(tables.cloud_accounts.filter(account => account.role === 'superAdmin').length, 1);

  let tokenNow = Date.now();
  const tokenManager = new SessionTokenManager({
    secret: Buffer.from('isolated-test-signing-key'),
    ttlSeconds: 60,
    now: () => tokenNow,
  });
  const server = createApp({ db, tokenManager, logger: { error() {} } });
  const base = await listen(server);
  t.after(() => server.close());
  const post = (path, body, token) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': String(body.shopId || 'login').padEnd(16, '_'),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const rootResponse = await post('/api/login', { username: 'root', password: superEnv.SUPER_ADMIN_PASSWORD, shopId: '' });
  assert.equal(rootResponse.status, 200);
  const rootBody = await rootResponse.json();
  assert.equal(rootBody.role, 'superAdmin');
  assert.equal(typeof rootBody.accessToken, 'string');

  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal((await post('/api/admin/shops', shopPayload())).status, 401);
  }
  assert.equal((await post('/api/admin/shops', shopPayload(), tokenManager.issueSuperAdmin(9999).token)).status, 403);
  const created = await post('/api/admin/shops', shopPayload(), rootBody.accessToken);
  assert.equal(created.status, 201);
  assert.equal(tables.cloud_pharmacies[0].shop_id, 'SHOP-TEST-01');
  const persisted = tables.cloud_accounts.find(account => account.shop_id === 'SHOP-TEST-01');
  assert.ok(persisted);
  assert.equal(persisted.username, 'shop-owner');
  assert.notEqual(persisted.password_hash, shopPayload().password);
  assert.equal(await verifyPassword(shopPayload().password, persisted.password_hash), true);

  const secondClientLogin = await post('/api/login', {
    username: 'shop-owner',
    password: shopPayload().password,
    shopId: 'SHOP-TEST-01',
  });
  assert.equal(secondClientLogin.status, 200);
  const loginBody = await secondClientLogin.json();
  assert.equal(loginBody.shopId, 'SHOP-TEST-01');
  assert.equal(loginBody.pharmacy.name, 'Isolated Test Pharmacy');
  assert.equal('accessToken' in loginBody, false);
  assert.equal((await post('/api/login', { username: 'shop-owner', password: 'wrong-password-123', shopId: 'SHOP-TEST-01' })).status, 401);
  assert.equal((await post('/api/login', { username: 'shop-owner', password: shopPayload().password, shopId: 'OTHER-SHOP' })).status, 401);

  const retries = await Promise.all(Array.from({ length: 3 }, () => post('/api/admin/shops', shopPayload(), rootBody.accessToken)));
  assert.deepEqual(retries.map(r => r.status), [201, 201, 201]);
  assert.equal(tables.cloud_pharmacies.length, 1);
  assert.equal((await post('/api/admin/shops', shopPayload({ name: 'Changed' }), rootBody.accessToken)).status, 400);

  tables.cloud_pharmacies[0].status = 'suspended';
  assert.equal((await post('/api/login', { username: 'shop-owner', password: shopPayload().password, shopId: 'SHOP-TEST-01' })).status, 403);
  tables.cloud_pharmacies[0].status = 'active';
  tables.cloud_accounts.find(account => account.role === 'superAdmin').active = false;
  assert.equal((await post('/api/admin/shops', shopPayload({ shopId: 'SHOP-TEST-02' }), rootBody.accessToken)).status, 403);
  tables.cloud_accounts.find(account => account.role === 'superAdmin').active = true;

  failCreate();
  assert.equal((await post('/api/admin/shops', shopPayload({ shopId: 'SHOP-NETWORK-FAIL' }), rootBody.accessToken)).status, 503);
  assert.equal(tables.cloud_pharmacies.some(pharmacy => pharmacy.shop_id === 'SHOP-NETWORK-FAIL'), false);
  const otherLogin = await post('/api/login', { username: 'root', password: superEnv.SUPER_ADMIN_PASSWORD, shopId: '' });
  const otherToken = (await otherLogin.json()).accessToken;
  assert.notEqual(otherToken, rootBody.accessToken);
  assert.equal((await post('/api/logout', {}, otherToken)).status, 200);
  assert.equal((await post('/api/admin/shops', shopPayload(), otherToken)).status, 401);
  tables.cloud_accounts.find(account => account.role === 'superAdmin').session_version = 2;
  assert.equal((await post('/api/admin/shops', shopPayload(), rootBody.accessToken)).status, 401);
  tables.cloud_accounts.find(account => account.role === 'superAdmin').session_version = 1;
  tokenNow += 61_000;
  assert.equal((await post('/api/admin/shops', shopPayload({ shopId: 'SHOP-EXPIRED-SESSION' }), rootBody.accessToken)).status, 401);
});
