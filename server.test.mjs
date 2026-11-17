import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, bootstrapWithRetry } from './server.mjs';
import { DatabaseRequestError } from './supabase.mjs';
import { hashPassword, verifyPassword } from './password.mjs';

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

test('password hashes are salted and reject incorrect passwords', async () => {
  const hash = await hashPassword('a-long-password');
  assert.notEqual(hash, await hashPassword('a-long-password'));
  assert.equal(await verifyPassword('a-long-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('anything', 'invalid'), false);
});

test('login enforces shop scope, active accounts, licenses and hides hashes', async t => {
  const hash = await hashPassword('a-long-password');
  let active = true;
  let status = 'active';
  let expiry = '2099-01-01T00:00:00Z';
  const server = createApp({ db: async (table, query) => {
    if (table === 'cloud_pharmacies') {
      if (query.get('shop_id') !== 'eq.P1') return [];
      return [{ shop_id: 'P1', name: 'Test Pharmacy', address: 'Test Address', status, license_expiry_date: expiry }];
    }
    if (query.get('shop_id') !== 'eq.P1' || query.get('username') !== 'eq.owner') return [];
    return [{ role: 'admin', username: 'owner', shop_id: 'P1', active, password_hash: hash }];
  } });
  const base = await listen(server);
  t.after(() => server.close());
  const login = (password = 'a-long-password', shopId = 'P1') => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner', shopId, password }),
  });
  let response = await login();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pharmacy.name, 'Test Pharmacy');
  assert.equal(JSON.stringify(body).includes('scrypt'), false);
  assert.equal((await login('wrong')).status, 401);
  assert.equal((await login('a-long-password', 'P2')).status, 401);
  active = false;
  assert.equal((await login()).status, 401);
  active = true; status = 'suspended';
  assert.equal((await login()).status, 403);
  status = 'active'; expiry = '2000-01-01T00:00:00Z';
  assert.equal((await login()).status, 403);
});

test('health is liveness, readiness requires bootstrap and database access', async t => {
  let bootstrapped = false;
  let unavailable = true;
  const server = createApp({
    getBootstrapped: () => bootstrapped,
    db: async () => {
      if (unavailable) throw new DatabaseRequestError({ status: 521, retryable: true });
      return [{ version: 4 }];
    },
    logger: { error() {} },
  });
  const base = await listen(server);
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await (await fetch(`${base}/version`)).json()).version, '4');
  assert.equal((await fetch(`${base}/api/admin/shops`, {method:'POST', body:'{}'})).status, 401);
  assert.equal((await fetch(`${base}/ready`)).status, 503);
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: '{}' })).status, 503);
  bootstrapped = true;
  assert.equal((await fetch(`${base}/ready`)).status, 503);
  unavailable = false;
  assert.equal((await fetch(`${base}/ready`)).status, 200);
});

test('bootstrap retries transient failures with controlled backoff', async () => {
  let calls = 0;
  const delays = [];
  const logs = [];
  const result = await bootstrapWithRetry({
    bootstrap: async () => {
      calls++;
      if (calls < 3) throw new DatabaseRequestError({ status: 521, retryable: true });
    },
    sleepImpl: async ms => delays.push(ms),
    logger: { error: message => logs.push(message) },
  });
  assert.equal(result, true);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(logs.every(line => !line.includes('secret')), true);
});
