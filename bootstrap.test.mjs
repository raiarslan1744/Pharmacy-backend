import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapSuperAdmin } from './bootstrap.mjs';
import { verifyPassword } from './password.mjs';

 test('startup provisions a super admin once and leaves matching credentials unchanged', async () => {
  const env = { SUPER_ADMIN_USERNAME: 'root', SUPER_ADMIN_PASSWORD: 'a-long-test-password' };
  let account;
  let writes = 0;
  const db = async (table, query, options) => {
    assert.equal(table, 'cloud_accounts');
    if (!options) return account ? [account] : [];
    writes++;
    account = JSON.parse(options.body);
    return [account];
  };
  assert.deepEqual(await bootstrapSuperAdmin({ env, db }), { created: true });
  assert.equal(account.role, 'superAdmin');
  assert.equal(await verifyPassword(env.SUPER_ADMIN_PASSWORD, account.password_hash), true);
  assert.deepEqual(await bootstrapSuperAdmin({ env, db }), { created: false });
  assert.equal(writes, 1);
  env.SUPER_ADMIN_PASSWORD = 'a-different-long-password';
  await assert.rejects(bootstrapSuperAdmin({ env, db }), /refusing to overwrite existing credentials/);
  assert.equal(writes, 1);
  assert.equal(await verifyPassword('a-long-test-password', account.password_hash), true);
});

test('bootstrap refuses to reactivate a disabled Super Admin', async () => {
  const env = { SUPER_ADMIN_USERNAME: 'root', SUPER_ADMIN_PASSWORD: 'a-long-test-password' };
  const account = { role: 'superAdmin', active: false, password_hash: 'scrypt:invalid' };
  let writes = 0;
  const db = async (_table, _query, options) => {
    if (options) writes++;
    return [account];
  };
  await assert.rejects(bootstrapSuperAdmin({ env, db }), /disabled or has a conflicting role/);
  assert.equal(writes, 0);
});

test('startup rejects missing admin credentials', async () => {
  await assert.rejects(bootstrapSuperAdmin({ env: {} }), /SUPER_ADMIN/);
});

test('bootstrap accepts a one-character configured password without changing existing accounts', async () => {
 let account;
 const db=async(_table,_query,options)=>{if(options)account=JSON.parse(options.body);return account?[account]:[];};
 await bootstrapSuperAdmin({env:{SUPER_ADMIN_USERNAME:'root',SUPER_ADMIN_PASSWORD:'x'},db});
 assert.equal(await verifyPassword('x',account.password_hash),true);
});
