const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526]);
const RETRY_DELAYS_MS = [250, 500, 1000];
const DEFAULT_TIMEOUT_MS = 10_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class DatabaseRequestError extends Error {
  constructor({ status = null, code = null, retryable = false, cause = null } = {}) {
    const statusText = status === null ? 'network/timeout error' : `HTTP ${status}`;
    const codeText = code ? `, PostgREST code ${code}` : '';
    super(`Supabase Data API request failed (${statusText}${codeText})`, { cause });
    this.name = 'DatabaseRequestError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function databaseErrorSummary(error) {
  if (error instanceof DatabaseRequestError) return error.message;
  if (error?.message === 'Missing Supabase configuration') return 'Missing required Supabase configuration.';
  if (error?.message === 'Invalid Supabase project URL') return 'Invalid Supabase project URL; expected the project API origin.';
  return 'Unexpected database error; sensitive details were suppressed.';
}

function buildEndpoint(rawUrl, table, query) {
  const validTable = typeof table === 'string' && /^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(table);
  const validRpc = typeof table === 'string' && /^rpc\/[a-zA-Z_][a-zA-Z0-9_$]*$/.test(table);
  if (!validTable && !validRpc) {
    throw new TypeError('Invalid database table identifier');
  }
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    throw new Error('Invalid Supabase project URL');
  }
  const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !localHttp) || !base.hostname || (base.pathname !== '/' && base.pathname !== '') || base.search || base.hash || base.username || base.password) {
    throw new Error('Invalid Supabase project URL');
  }
  const endpoint = new URL(`/rest/v1/${table}`, base.origin);
  if (query) endpoint.search = query instanceof URLSearchParams ? query.toString() : String(query);
  return endpoint;
}

function isSafeToRetry(method, endpoint) {
  if (method === 'GET' || method === 'HEAD') return true;
  return method === 'POST' && endpoint.searchParams.has('on_conflict');
}

function responseCode(body) {
  return body && typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
}

export function createDatabaseClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return async function database(table, query = '', options = {}) {
    const projectUrl = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (!projectUrl || !key) throw new Error('Missing Supabase configuration');

    const endpoint = buildEndpoint(projectUrl, table, query);
    const method = String(options.method || 'GET').toUpperCase();
    const retryAllowed = isSafeToRetry(method, endpoint);
    const headers = {
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers,
    };
    const requestOptions = { ...options, method, headers };
    delete requestOptions.fetchImpl;
    delete requestOptions.sleepImpl;
    delete requestOptions.timeoutMs;

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          ...requestOptions,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        if (retryAllowed && attempt < RETRY_DELAYS_MS.length) {
          await sleepImpl(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new DatabaseRequestError({ retryable: true, cause });
      }

      if (response.ok) return response.status === 204 ? null : response.json();

      let body = null;
      try { body = await response.json(); } catch { /* Keep error reporting to status/code only. */ }
      const code = responseCode(body);
      const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
      if (retryAllowed && retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleepImpl(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new DatabaseRequestError({
        status: response.status,
        code,
        retryable,
      });
    }
  };
}

export const database = createDatabaseClient();
