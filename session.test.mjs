import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTokenManager } from './session.mjs';

test('Super Admin session tokens are signed, scoped, and expire', () => {
  let now = 1_800_000_000_000;
  const manager = new SessionTokenManager({ secret: Buffer.from('test-only-secret-material'), ttlSeconds: 60, now: () => now });
  const issued = manager.issueSuperAdmin(42);
  assert.equal(manager.verify(issued.token)?.sub, '42');
  assert.equal(manager.verify(issued.token)?.role, 'superAdmin');
  assert.equal(new SessionTokenManager({ secret: Buffer.from('other-secret') }).verify(issued.token), null);
  now += 61_000;
  assert.equal(manager.verify(issued.token), null);
});

test('tokens have unique IDs and reject tampering and lifetimes over eight hours', () => {
  const manager = new SessionTokenManager();
  const a = manager.issueSuperAdmin(1);
  const b = manager.issueSuperAdmin(1);
  assert.notEqual(manager.verify(a.token).jti, manager.verify(b.token).jti);
  assert.equal(manager.verify('x' + a.token), null);
  assert.throws(() => new SessionTokenManager({ttlSeconds: 28801}));
});
