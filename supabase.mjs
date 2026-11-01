export async function database(table, query = '', options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Missing Supabase configuration');
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    ...options,
    headers: { apikey: key, 'Content-Type': 'application/json',
      Prefer: 'return=representation', ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Database request failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
