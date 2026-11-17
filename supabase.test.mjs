import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseClient, DatabaseRequestError } from './supabase.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('uses the Supabase REST endpoint and sends a secret key only as apikey', async () => {
  let requestUrl;
  let requestOptions;
  const db = createDatabaseClient({
    env: { SUPABASE_URL: 'https://project-ref.supabase.co/', SUPABASE_SECRET_KEY: 'sb_secret_test_value' },
    fetchImpl: async (url, options) => {
      requestUrl = String(url);
      requestOptions = options;
      return json([{ shop_id: 'S1' }]);
    },
  });
  const result = await db('cloud_pharmacies', new URLSearchParams({ select: 'shop_id' }));
  assert.equal(requestUrl, 'https://project-ref.supabase.co/rest/v1/cloud_pharmacies?select=shop_id');
  assert.equal(requestOptions.headers.apikey, 'sb_secret_test_value');
  assert.equal(Object.keys(requestOptions.headers).some(name => name.toLowerCase() === 'authorization'), false);
  assert.deepEqual(result, [{ shop_id: 'S1' }]);
});

test('retries a transient 521 response with bounded backoff', async () => {
  let calls = 0;
  const delays = [];
  const db = createDatabaseClient({
    env: { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_SECRET_KEY: 'secret-not-for-logs' },
    fetchImpl: async () => ++calls < 3 ? json({ message: 'upstream unavailable' }, 521) : json([{ id: 1 }]),
    sleepImpl: async ms => delays.push(ms),
  });
  assert.deepEqual(await db('cloud_accounts', 'select=id'), [{ id: 1 }]);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('does not retry a non-transient 404 and exposes only its safe PostgREST code', async () => {
  let calls = 0;
  const db = createDatabaseClient({
    env: { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_SECRET_KEY: 'secret-not-for-logs' },
    fetchImpl: async () => { calls++; return json({ code: 'PGRST205', message: 'table was not found' }, 404); },
    sleepImpl: async () => assert.fail('404 must not be retried'),
  });
  await assert.rejects(db('cloud_accounts'), error => {
    assert.ok(error instanceof DatabaseRequestError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'PGRST205');
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes('secret-not-for-logs'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('rejects non-origin Supabase URLs rather than building an ambiguous endpoint', async () => {
  const db = createDatabaseClient({
    env: { SUPABASE_URL: 'https://project-ref.supabase.co/rest/v1', SUPABASE_SECRET_KEY: 'secret' },
    fetchImpl: async () => assert.fail('must not send a malformed request'),
  });
  await assert.rejects(db('cloud_accounts'), /Invalid Supabase project URL/);
});

test('calls the RPC route and does not retry a provisioning POST', async () => {
  let calls = 0;
  let requestUrl;
  const db = createDatabaseClient({
    env: { SUPABASE_URL: 'https://project-ref.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    fetchImpl: async (url, options) => {
      calls++;
      requestUrl = String(url);
      assert.equal(options.method, 'POST');
      return json({ code: '57014' }, 503);
    },
    sleepImpl: async () => assert.fail('RPC provisioning must not be retried'),
  });
  await assert.rejects(db('rpc/create_cloud_shop', '', { method: 'POST', body: '{}' }), error => {
    assert.ok(error instanceof DatabaseRequestError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(requestUrl, 'https://project-ref.supabase.co/rest/v1/rpc/create_cloud_shop');
  assert.equal(calls, 1);
});
