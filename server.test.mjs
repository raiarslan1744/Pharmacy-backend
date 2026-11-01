import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.mjs';
import { hashPassword, verifyPassword } from './password.mjs';

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
  let expiry = null;
  const server = createApp({ db: async (table, query) => {
    if (table === 'cloud_pharmacies') return [{ shop_id: 'P1', name: 'Test Pharmacy', address: 'Test Address', status, license_expiry_date: expiry }];
    assert.equal(query.get('shop_id'), 'eq.P1');
    assert.equal(query.get('username'), 'eq.owner');
    return [{ role: 'admin', username: 'owner', shop_id: 'P1', active, password_hash: hash }];
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const login = (password = 'a-long-password') => fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', body: JSON.stringify({ username: 'owner', shopId: 'P1', password }) });
  let response = await login();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pharmacy.name, 'Test Pharmacy');
  assert.equal(JSON.stringify(body).includes('scrypt'), false);
  assert.equal((await login('wrong')).status, 401);
  active = false;
  assert.equal((await login()).status, 401);
  active = true; status = 'suspended';
  assert.equal((await login()).status, 403);
  status = 'active'; expiry = '2000-01-01T00:00:00Z';
  assert.equal((await login()).status, 403);
});
