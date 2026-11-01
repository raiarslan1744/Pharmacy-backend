import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapSuperAdmin } from './bootstrap.mjs';
import { verifyPassword } from './password.mjs';

test('startup provisions admin from environment and avoids rewriting unchanged credentials', async () => {
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
  await bootstrapSuperAdmin({ env, db });
  assert.equal(account.role, 'superAdmin');
  assert.equal(await verifyPassword(env.SUPER_ADMIN_PASSWORD, account.password_hash), true);
  await bootstrapSuperAdmin({ env, db });
  assert.equal(writes, 1);
  env.SUPER_ADMIN_PASSWORD = 'a-different-long-password';
  await bootstrapSuperAdmin({ env, db });
  assert.equal(writes, 2);
  assert.equal(await verifyPassword(env.SUPER_ADMIN_PASSWORD, account.password_hash), true);
});
test('startup rejects missing or weak admin credentials', async () => {
  await assert.rejects(bootstrapSuperAdmin({ env: {} }), /SUPER_ADMIN/);
});
