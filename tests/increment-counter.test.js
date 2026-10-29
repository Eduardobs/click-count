import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../supabase/functions/increment-counter/index.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
let handler;
globalThis.Deno = {
  env: { get: name => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only' })[name] },
  serve: value => { handler = value; },
};
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
after(() => { delete globalThis.Deno; });

function request(authorization, body = '{}') {
  return new Request('https://test.supabase.co/functions/v1/increment-counter', {
    method: 'POST', headers: { Origin: 'http://localhost:8080', ...(authorization ? { Authorization: authorization } : {}) }, body,
  });
}
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
test('anonymous clicks remain public and ignore a forged user ID', async () => {
  await withFetch(async (url, options) => {
    assert.match(url, /rpc\/increment_counter_backend$/);
    assert.deepEqual(JSON.parse(options.body), { click_user_id: null });
    return Response.json([{ new_value: '7', user_clicks: null }]);
  }, async () => {
    const response = await handler(request(null, '{"click_user_id":"forged"}'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).new_value, '7');
  });
});
test('authenticated clicks use the identity returned by Auth', async () => {
  let calls = 0;
  await withFetch(async (url, options) => {
    calls += 1;
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.Authorization, 'Bearer valid');
      return Response.json({ id: 'verified-user' });
    }
    assert.deepEqual(JSON.parse(options.body), { click_user_id: 'verified-user' });
    return Response.json([{ new_value: '8', user_clicks: '3' }]);
  }, async () => {
    const response = await handler(request('Bearer valid', '{"click_user_id":"forged"}'));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user_clicks, '3');
    assert.equal(calls, 2);
  });
});
test('invalid sessions cannot increment the counter', async () => {
  let calls = 0;
  await withFetch(async () => { calls += 1; return Response.json({}, { status: 401 }); }, async () => {
    const response = await handler(request('Bearer invalid'));
    assert.equal(response.status, 401);
    assert.equal(calls, 1);
  });
});
test('CORS preflight permits authorization from allowed origins only', async () => {
  const response = await handler(new Request('https://test/', {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' },
  }));
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /authorization/);
  const denied = await handler(new Request('https://test/', {
    method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' },
  }));
  assert.equal(denied.status, 403);
});
